package secrets

import (
	"bytes"
	"crypto/sha1"
	"crypto/subtle"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
	"unicode/utf16"
)

// A reader for the classic Java KeyStore (JKS) format: enough to verify the
// store password, find an alias, verify the key password and read the
// certificate. PKCS#12 stores go through go-pkcs12 instead.

type jksEntry struct {
	Alias     string
	IsKey     bool
	Protected []byte   // EncryptedPrivateKeyInfo DER (key entries)
	Chain     [][]byte // certificate DER
}

var errJKSPassword = errors.New("wrong keystore password")

func jksPassBytes(pw string) []byte {
	var b []byte
	for _, u := range utf16.Encode([]rune(pw)) {
		b = binary.BigEndian.AppendUint16(b, u)
	}
	return b
}

func parseJKS(data []byte, storePassword string) ([]jksEntry, error) {
	if len(data) < 32 || binary.BigEndian.Uint32(data) != 0xFEEDFEED {
		return nil, errors.New("not a JKS keystore")
	}
	body, sum := data[:len(data)-20], data[len(data)-20:]
	h := sha1.New()
	h.Write(jksPassBytes(storePassword))
	h.Write([]byte("Mighty Aphrodite"))
	h.Write(body)
	if subtle.ConstantTimeCompare(h.Sum(nil), sum) != 1 {
		return nil, errJKSPassword
	}
	r := &jksReader{b: body[8:]}
	version := binary.BigEndian.Uint32(data[4:])
	if version != 1 && version != 2 {
		return nil, fmt.Errorf("unsupported JKS version %d", version)
	}
	n := int(r.u32())
	var out []jksEntry
	for i := 0; i < n && r.err == nil; i++ {
		tag := r.u32()
		e := jksEntry{Alias: r.utf()}
		r.u64() // creation date
		switch tag {
		case 1:
			e.IsKey = true
			e.Protected = r.bytes(int(r.u32()))
			nc := int(r.u32())
			for j := 0; j < nc && r.err == nil; j++ {
				if version == 2 {
					r.utf() // cert type
				}
				e.Chain = append(e.Chain, r.bytes(int(r.u32())))
			}
		case 2:
			if version == 2 {
				r.utf()
			}
			e.Chain = [][]byte{r.bytes(int(r.u32()))}
		default:
			return nil, fmt.Errorf("unknown JKS entry tag %d", tag)
		}
		out = append(out, e)
	}
	if r.err != nil {
		return nil, r.err
	}
	return out, nil
}

type jksReader struct {
	b   []byte
	err error
}

func (r *jksReader) bytes(n int) []byte {
	if r.err != nil || n < 0 || n > len(r.b) {
		r.err = errors.New("truncated JKS keystore")
		return nil
	}
	v := r.b[:n]
	r.b = r.b[n:]
	return v
}
func (r *jksReader) u32() uint32 {
	v := r.bytes(4)
	if v == nil {
		return 0
	}
	return binary.BigEndian.Uint32(v)
}
func (r *jksReader) u64() uint64 {
	v := r.bytes(8)
	if v == nil {
		return 0
	}
	return binary.BigEndian.Uint64(v)
}
func (r *jksReader) utf() string {
	v := r.bytes(2)
	if v == nil {
		return ""
	}
	return string(r.bytes(int(binary.BigEndian.Uint16(v))))
}

// jksCheckKeyPassword verifies the key password against Sun's proprietary
// key protector (SHA-1 keystream with a 20-byte check value).
func jksCheckKeyPassword(protected []byte, keyPassword string) error {
	var epki struct {
		Algo pkix.AlgorithmIdentifier
		Data []byte
	}
	if _, err := asn1.Unmarshal(protected, &epki); err != nil {
		return fmt.Errorf("unreadable key entry: %w", err)
	}
	if !epki.Algo.Algorithm.Equal(asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 42, 2, 17, 1, 1}) {
		return errors.New("key entry uses an unsupported protection scheme")
	}
	d := epki.Data
	if len(d) < 40 {
		return errors.New("key entry too short")
	}
	salt, enc, check := d[:20], d[20:len(d)-20], d[len(d)-20:]
	pw := jksPassBytes(keyPassword)
	plain := make([]byte, len(enc))
	digest := salt
	for i := 0; i < len(enc); {
		h := sha1.New()
		h.Write(pw)
		h.Write(digest)
		digest = h.Sum(nil)
		for j := 0; j < len(digest) && i < len(enc); j, i = j+1, i+1 {
			plain[i] = enc[i] ^ digest[j]
		}
	}
	h := sha1.New()
	h.Write(pw)
	h.Write(plain)
	if !bytes.Equal(h.Sum(nil), check) {
		return errors.New("wrong key password")
	}
	return nil
}

func certFingerprint(der []byte) (string, error) {
	if _, err := x509.ParseCertificate(der); err != nil {
		return "", err
	}
	return fullHash(der), nil
}

func colonHex(h string) string {
	var parts []string
	for i := 0; i+2 <= len(h); i += 2 {
		parts = append(parts, strings.ToUpper(h[i:i+2]))
	}
	return strings.Join(parts, ":")
}
