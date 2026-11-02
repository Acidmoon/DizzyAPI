package httpapi

import (
	"bytes"
	"encoding/json"
)

// normalizeOpenAICompatRoles rewrites the OpenAI "developer" role to "system"
// for upstreams that only accept the classic system/user/assistant/tool roles
// (for example api.deepseek.com).
//
// It is deliberately a no-op unless the body actually contains "developer":
// the same-protocol fast path promises byte-exact passthrough for every other
// request.
func normalizeOpenAICompatRoles(body []byte) []byte {
	if !bytes.Contains(body, []byte(`"developer"`)) {
		return body
	}

	var root map[string]json.RawMessage
	if err := json.Unmarshal(body, &root); err != nil {
		return body
	}
	rawMessages, ok := root["messages"]
	if !ok {
		return body
	}
	var messages []map[string]json.RawMessage
	if err := json.Unmarshal(rawMessages, &messages); err != nil {
		return body
	}

	changed := false
	for _, message := range messages {
		rawRole, ok := message["role"]
		if !ok {
			continue
		}
		var role string
		if json.Unmarshal(rawRole, &role) != nil || role != "developer" {
			continue
		}
		message["role"] = json.RawMessage(`"system"`)
		changed = true
	}
	if !changed {
		return body
	}

	encodedMessages, err := json.Marshal(messages)
	if err != nil {
		return body
	}
	root["messages"] = encodedMessages
	encoded, err := json.Marshal(root)
	if err != nil {
		return body
	}
	return encoded
}
