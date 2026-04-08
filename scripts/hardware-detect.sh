#!/bin/bash

set -euo pipefail

MIN_CPU_CORES=2
MIN_RAM_GB=2
MIN_DISK_GB=16

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

detect_cpu() {
    local cpu_info=""
    
    if command -v lscpu &>/dev/null; then
        cpu_info=$(lscpu)
    elif [ -f /proc/cpuinfo ]; then
        cpu_info=$(cat /proc/cpuinfo)
    fi
    
    local model=$(echo "$cpu_info" | grep -E "^model name" | head -1 | cut -d: -f2 | xargs || echo "Unknown")
    local cores=$(echo "$cpu_info" | grep -E "^Core\(s\)|cpu cores|^Processor" | head -1 | grep -oE '[0-9]+' | head -1 || echo "0")
    local threads=$(echo "$cpu_info" | grep -E "^Thread\(s\)|^CPU(s)" | head -1 | grep -oE '[0-9]+' | head -1 || echo "$cores")
    
    if [ "$cores" -eq 0 ] && [ -f /proc/cpuinfo ]; then
        cores=$(grep -c ^processor /proc/cpuinfo)
        threads=$cores
    fi
    
    echo "  Model: $model"
    echo "  Cores: $cores"
    echo "  Threads: $threads"
}

detect_ram() {
    local total_kb=""
    local available_kb=""
    
    if [ -f /proc/meminfo ]; then
        total_kb=$(grep MemTotal /proc/meminfo | awk '{print $2}')
        available_kb=$(grep MemAvailable /proc/meminfo | awk '{print $2}')
    fi
    
    local total_gb=$(echo "scale=2; $total_kb / 1024 / 1024" | bc 2>/dev/null || echo "0")
    local available_gb=$(echo "scale=2; $available_kb / 1024 / 1024" | bc 2>/dev/null || echo "0")
    
    echo "  Total: ${total_gb} GB"
    echo "  Available: ${available_gb} GB"
}

detect_disk() {
    echo "  Storage Devices:"
    
    if command -v lsblk &>/dev/null; then
        lsblk -o NAME,SIZE,TYPE,MOUNTPOINT | sed 's/^/    /'
    elif [ -f /proc/partitions ]; then
        cat /proc/partitions | grep -E 'sd|nvme|vd' | sed 's/^/    /'
    fi
    
    echo ""
    echo "  Mount Points:"
    if [ -f /proc/mounts ]; then
        grep -E '^/dev' /proc/mounts | awk '{print "    " $1 " on " $2 " (" $3 ")"}' | head -10
    fi
    
    echo ""
    echo "  Disk Space:"
    df -h | grep -E '^/dev|Filesystem' | sed 's/^/    /'
}

detect_gpu() {
    echo "  Graphics:"
    
    if command -v lspci &>/dev/null; then
        local gpu_info=$(lspci | grep -iE 'vga|graphics|display' || true)
        if [ -n "$gpu_info" ]; then
            echo "$gpu_info" | sed 's/^/    /'
        else
            echo "    No GPU detected"
        fi
    elif [ -f /sys/class/drm/card0/device/uevent ]; then
        cat /sys/class/drm/card0/device/uevent 2>/dev/null | grep -i PRODUCT_NAME | sed 's/^/    /' || echo "    No GPU detected"
    else
        echo "    Unable to detect GPU"
    fi
}

detect_network() {
    echo "  Network Interfaces:"
    if command -v ip &>/dev/null; then
        ip link show | grep -E '^[0-9]+:' | awk '{print "    " $2}' | sed 's/:$//'
    elif [ -f /proc/net/dev ]; then
        cat /proc/net/dev | grep -vE 'lo:|Inter|Receive' | awk -F: '{print "    " $1}' | head -10
    fi
}

detect_virtualization() {
    echo "  Virtualization:"
    
    if [ -f /sys/class/dmi/sys/vendor ]; then
        local vendor=$(cat /sys/class/dmi/sys/vendor 2>/dev/null || true)
        echo "    Vendor: $vendor"
    fi
    
    if command -v systemd-detect-virt &>/dev/null; then
        local virt=$(systemd-detect-virt 2>/dev/null || echo "none")
        echo "    Type: $virt"
    elif [ -f /proc/1/cgroup ]; then
        if grep -qE 'docker|lxc|kubepods' /proc/1/cgroup 2>/dev/null; then
            echo "    Type: container"
        else
            echo "    Type: bare-metal"
        fi
    fi
}

detect_os() {
    echo "  OS:"
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        echo "    Name: $NAME"
        echo "    Version: $VERSION"
    fi
    echo "    Kernel: $(uname -r)"
}

check_minimums() {
    local cores=$1
    local ram_gb=$2
    local disk_gb=$3
    
    echo ""
    echo "=== Minimum Requirements Check ==="
    echo ""
    
    local warnings=0
    
    if [ "$cores" -lt "$MIN_CPU_CORES" ]; then
        log_warn "CPU cores below minimum ($cores < $MIN_CPU_CORES)"
        warnings=1
    else
        log_info "CPU: OK ($cores cores)"
    fi
    
    if (( $(echo "$ram_gb < $MIN_RAM_GB" | bc -l) )); then
        log_warn "RAM below minimum (${ram_gb}GB < ${MIN_RAM_GB}GB)"
        warnings=1
    else
        log_info "RAM: OK (${ram_gb}GB)"
    fi
    
    if [ "$disk_gb" -lt "$MIN_DISK_GB" ]; then
        log_warn "Disk below minimum (${disk_gb}GB < ${MIN_DISK_GB}GB)"
        warnings=1
    else
        log_info "Disk: OK (${disk_gb}GB)"
    fi
    
    if [ $warnings -eq 0 ]; then
        echo ""
        log_info "All minimum requirements met!"
    fi
    
    return $warnings
}

generate_report() {
    local output_file="${1:-hardware-report.txt}"
    
    echo "Generating hardware report: $output_file"
    
    {
        echo "LibreServ Hardware Report"
        echo "========================="
        echo "Generated: $(date -Iseconds)"
        echo "Hostname: $(hostname)"
        echo ""
        
        echo "=== CPU ==="
        detect_cpu
        echo ""
        
        echo "=== RAM ==="
        detect_ram
        echo ""
        
        echo "=== Disk ==="
        detect_disk
        echo ""
        
        echo "=== GPU ==="
        detect_gpu
        echo ""
        
        echo "=== Network ==="
        detect_network
        echo ""
        
        echo "=== Virtualization ==="
        detect_virtualization
        echo ""
        
        echo "=== Operating System ==="
        detect_os
        echo ""
        
        echo "=== Docker Info ==="
        if command -v docker &>/dev/null; then
            docker version --format '{{.Server.Version}}' 2>/dev/null && echo "    Docker version: $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo 'not running')" || echo "    Docker not available"
        else
            echo "    Docker not installed"
        fi
        echo ""
        
    } > "$output_file"
    
    log_info "Report saved to: $output_file"
}

json_output() {
    local cores=$1
    local ram_gb=$2
    local disk_gb=$3

    cat <<EOF
{
  "cpu": {
    "cores": $cores,
    "threads": $cores
  },
  "ram": {
    "total_gb": $ram_gb
  },
  "disk": {
    "total_gb": $disk_gb
  },
  "meets_minimums": $([ $((cores >= MIN_CPU_CORES && $(echo "$ram_gb >= $MIN_RAM_GB" | bc -l) && disk_gb >= MIN_DISK_GB)) -eq 1 ] && echo "true" || echo "false")
}
EOF
}

main() {
    local json_only=false
    local report_mode=false
    
    if [[ "${1:-}" == "--json" ]]; then
        json_only=true
    elif [[ "${1:-}" == "--report" ]]; then
        report_mode=true
    fi
    
    if [ "$json_only" = false ]; then
        echo "LibreServ Hardware Detection"
        echo "============================"
        echo ""
    fi
    
    local cores=0
    local ram_gb=0
    local disk_gb=0
    
    if [ "$json_only" = false ]; then
        echo "=== CPU ==="
        detect_cpu
    fi
    cores=$(lscpu 2>/dev/null | grep -E '^CPU\(s\)' | grep -oE '[0-9]+' | head -1 || echo "0")
    [ "$cores" -eq 0 ] && cores=$(grep -c ^processor /proc/cpuinfo 2>/dev/null || echo "0")
    
    if [ "$json_only" = false ]; then
        echo ""
        
        echo "=== RAM ==="
        detect_ram
        echo ""
        
        echo "=== Disk ==="
        detect_disk
        echo ""
        
        echo "=== GPU ==="
        detect_gpu
        echo ""
        
        echo "=== Network ==="
        detect_network
        echo ""
        
        echo "=== Virtualization ==="
        detect_virtualization
        echo ""
        
        echo "=== Operating System ==="
        detect_os
        echo ""
        
        check_minimums "$cores" "$ram_gb" "$disk_gb"
    fi
    
    if [ "$json_only" = true ]; then
        json_output "$cores" "$ram_gb" "$disk_gb"
        return 0
    fi
    
    if [ "$report_mode" = true ]; then
        generate_report "${2:-hardware-report.txt}"
    fi
}

main "$@"
