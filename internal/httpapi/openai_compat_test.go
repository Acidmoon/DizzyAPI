package httpapi

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestNormalizeOpenAICompatRolesMapsDeveloper(t *testing.T) {
	body := []byte(`{"model":"m","messages":[{"role":"developer","content":"be terse"},{"role":"user","content":"hi"}],"temperature":0.2}`)
	got := normalizeOpenAICompatRoles(body)

	var root struct {
		Messages []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
		Temperature float64 `json:"temperature"`
	}
	if err := json.Unmarshal(got, &root); err != nil {
		t.Fatalf("normalized body is not JSON: %v", err)
	}
	if len(root.Messages) != 2 || root.Messages[0].Role != "system" || root.Messages[1].Role != "user" {
		t.Fatalf("roles = %#v, want system,user", root.Messages)
	}
	if root.Temperature != 0.2 {
		t.Fatalf("temperature lost: %v", root.Temperature)
	}
	if bytes.Contains(got, []byte(`"developer"`)) {
		t.Fatalf("developer role still present: %s", got)
	}
}

func TestNormalizeOpenAICompatRolesNoDeveloperIsByteExact(t *testing.T) {
	body := []byte(`{"model":"m","messages":[{"role":"system","content":"x"},{"role":"user","content":"hi"}]}`)
	got := normalizeOpenAICompatRoles(body)
	if !bytes.Equal(got, body) {
		t.Fatalf("body changed without developer:\n got %s\nwant %s", got, body)
	}
}

func TestNormalizeOpenAICompatRolesInvalidJSONIsUnchanged(t *testing.T) {
	body := []byte(`{"messages":[{"role":"developer"}`)
	got := normalizeOpenAICompatRoles(body)
	if !bytes.Equal(got, body) {
		t.Fatalf("invalid body changed:\n got %s\nwant %s", got, body)
	}
}

func TestNormalizeOpenAICompatRolesPreservesMessageFields(t *testing.T) {
	body := []byte(`{"messages":[{"role":"developer","name":"ops","content":[{"type":"text","text":"x"}]}]}`)
	got := normalizeOpenAICompatRoles(body)
	if !bytes.Contains(got, []byte(`"name":"ops"`)) || !bytes.Contains(got, []byte(`"type":"text"`)) {
		t.Fatalf("message fields lost: %s", got)
	}
	if !bytes.Contains(got, []byte(`"role":"system"`)) {
		t.Fatalf("role not mapped: %s", got)
	}
}
