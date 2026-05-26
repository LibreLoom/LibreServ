package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

type chatCompletionResponse struct {
	Model string `json:"model"`
	Usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
	} `json:"usage"`
}

type InferenceProxy struct {
	baseURL    string
	apiKey     string
	httpClient *http.Client
	db         *DB
}

func NewInferenceProxy(baseURL, apiKey string, db *DB) *InferenceProxy {
	return &InferenceProxy{
		baseURL: strings.TrimRight(baseURL, "/"),
		apiKey:  apiKey,
		db:      db,
		httpClient: &http.Client{
			Timeout: 5 * time.Minute,
			Transport: &http.Transport{
				MaxIdleConns:        50,
				MaxIdleConnsPerHost: 20,
				MaxConnsPerHost:     30,
				IdleConnTimeout:     90 * time.Second,
			},
		},
	}
}

func (p *InferenceProxy) HandleChatCompletions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	deviceID := r.Header.Get("X-Device-ID")
	if deviceID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{
			"error": map[string]string{
				"message": "X-Device-ID header is required. This identifies your server so we can check your subscription.",
				"type":    "invalid_request_error",
			},
		})
		return
	}

	device, err := p.db.GetDevice(deviceID)
	if err != nil {
		log.Printf("inference-proxy: device lookup failed for %s: %v", deviceID, err)
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{
			"error": map[string]string{
				"message": "Could not verify your subscription. Please try again later.",
				"type":    "server_error",
			},
		})
		return
	}

	planID := "free"
	if device != nil {
		if pid, ok := device["plan_id"].(string); ok {
			planID = pid
		}
	}

	plan, err := p.db.GetPlan(planID)
	if err != nil {
		log.Printf("inference-proxy: plan lookup failed for %s: %v", planID, err)
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{
			"error": map[string]string{
				"message": "Could not verify your subscription. Please try again later.",
				"type":    "server_error",
			},
		})
		return
	}

	creditCapUSD, _ := plan["credit_cap_usd"].(float64)
	if creditCapUSD > 0 {
		now := time.Now()
		startOfMonth := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
		usedUSD, err := p.db.CreditUsage(deviceID, startOfMonth)
		if err != nil {
			log.Printf("inference-proxy: credit check failed for %s: %v", deviceID, err)
			writeJSON(w, http.StatusInternalServerError, map[string]interface{}{
				"error": map[string]string{
					"message": "Could not check your credit usage. Please try again later.",
					"type":    "server_error",
				},
			})
			return
		}
		if usedUSD >= creditCapUSD {
			remaining := creditCapUSD - usedUSD
			if remaining < 0 {
				remaining = 0
			}
			log.Printf("inference-proxy: credit cap reached for %s (used=%.4f cap=%.4f)", deviceID, usedUSD, creditCapUSD)
			writeJSON(w, http.StatusPaymentRequired, map[string]interface{}{
				"error": map[string]interface{}{
					"message":       "Your monthly AI support credit has been used up. Upgrade your plan in Settings to get more, or wait for next month's reset.",
					"type":          "credit_limit_exceeded",
					"used_usd":      usedUSD,
					"cap_usd":       creditCapUSD,
					"remaining_usd": remaining,
				},
			})
			return
		}
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{
			"error": map[string]string{
				"message": "Could not read the request. Please try again.",
				"type":    "invalid_request_error",
			},
		})
		return
	}
	defer r.Body.Close()

	upstreamReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, p.baseURL+"/chat/completions", strings.NewReader(string(body)))
	if err != nil {
		log.Printf("inference-proxy: failed to create upstream request: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{
			"error": map[string]string{
				"message": "Something went wrong connecting to the AI provider. Please try again later.",
				"type":    "server_error",
			},
		})
		return
	}
	upstreamReq.Header.Set("Content-Type", "application/json")
	upstreamReq.Header.Set("Authorization", "Bearer "+p.apiKey)

	resp, err := p.httpClient.Do(upstreamReq)
	if err != nil {
		log.Printf("inference-proxy: upstream request failed: %v", err)
		writeJSON(w, http.StatusBadGateway, map[string]interface{}{
			"error": map[string]string{
				"message": "The AI provider is not responding. Please try again in a moment.",
				"type":    "upstream_error",
			},
		})
		return
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		log.Printf("inference-proxy: failed to read upstream response: %v", err)
		writeJSON(w, http.StatusBadGateway, map[string]interface{}{
			"error": map[string]string{
				"message": "Could not read the AI provider's response. Please try again.",
				"type":    "upstream_error",
			},
		})
		return
	}

	for key, values := range resp.Header {
		if strings.EqualFold(key, "Content-Length") || strings.EqualFold(key, "Transfer-Encoding") {
			continue
		}
		for _, v := range values {
			w.Header().Add(key, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	w.Write(respBody)

	if resp.StatusCode == http.StatusOK {
		go p.recordUsageFromResponse(deviceID, respBody)
	}
}

func (p *InferenceProxy) HandleModels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	deviceID := r.Header.Get("X-Device-ID")
	if deviceID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{
			"error": map[string]string{
				"message": "X-Device-ID header is required.",
				"type":    "invalid_request_error",
			},
		})
		return
	}

	upstreamReq, err := http.NewRequestWithContext(r.Context(), http.MethodGet, p.baseURL+"/models", nil)
	if err != nil {
		log.Printf("inference-proxy: failed to create models request: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{
			"error": map[string]string{
				"message": "Could not fetch the model list. Please try again later.",
				"type":    "server_error",
			},
		})
		return
	}
	upstreamReq.Header.Set("Authorization", "Bearer "+p.apiKey)

	resp, err := p.httpClient.Do(upstreamReq)
	if err != nil {
		log.Printf("inference-proxy: models upstream failed: %v", err)
		writeJSON(w, http.StatusBadGateway, map[string]interface{}{
			"error": map[string]string{
				"message": "The AI provider is not responding. Please try again in a moment.",
				"type":    "upstream_error",
			},
		})
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

func (p *InferenceProxy) recordUsageFromResponse(deviceID string, body []byte) {
	var resp chatCompletionResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		log.Printf("inference-proxy: failed to parse response for metering: %v", err)
		return
	}

	if resp.Usage.PromptTokens == 0 && resp.Usage.CompletionTokens == 0 {
		return
	}

	model := resp.Model
	if model == "" {
		model = "unknown"
	}

	plan, _ := p.db.GetPlan("free")
	device, _ := p.db.GetDevice(deviceID)
	if device != nil {
		if pid, ok := device["plan_id"].(string); ok && pid != "" {
			if p, err := p.db.GetPlan(pid); err == nil && p != nil {
				plan = p
			}
		}
	}

	costUSD := p.estimateCost(model, resp.Usage.PromptTokens, resp.Usage.CompletionTokens, plan)

	if err := p.db.RecordCredit(deviceID, "", model, resp.Usage.PromptTokens, resp.Usage.CompletionTokens, costUSD); err != nil {
		log.Printf("inference-proxy: failed to record credit for %s: %v", deviceID, err)
	} else {
		log.Printf("inference-proxy: recorded usage for %s model=%s in=%d out=%d cost=%.6f", deviceID, model, resp.Usage.PromptTokens, resp.Usage.CompletionTokens, costUSD)
	}
}

func (p *InferenceProxy) estimateCost(model string, inputTokens, outputTokens int, plan map[string]interface{}) float64 {
	return float64(inputTokens+outputTokens) * 0.000001
}
