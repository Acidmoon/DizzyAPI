package apikeys

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
)

func hashOf(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])
}

func keyRecord(id, secret string) Key {
	return Key{
		KeyID:   id,
		UserID:  1,
		KeyHash: hashOf(secret),
		Profile: "billed",
		Name:    "name-" + id,
	}
}

func snapshot(keys ...Key) Snapshot {
	return Snapshot{Version: SnapshotVersion, Generation: 1, Keys: keys}
}

func TestNewCacheIsNotReady(t *testing.T) {
	cache := New()
	if cache.Ready() {
		t.Fatal("从未收到快照时 Ready 必须为 false")
	}
	if cache.Count() != 0 {
		t.Fatalf("初始 Count 应为 0：%d", cache.Count())
	}
	if _, ok := cache.Verify("anything"); ok {
		t.Fatal("未就绪时 Verify 不应命中")
	}
}

func TestReplaceAndVerify(t *testing.T) {
	cache := New()
	result, err := cache.Replace(snapshot(keyRecord("key-1", "dz-key-one"), keyRecord("key-2", "dz-key-two")))
	if err != nil {
		t.Fatalf("Replace: %v", err)
	}
	if result.Keys != 2 || result.Revision == "" || result.Revision == emptyRevision {
		t.Fatalf("结果不对：%+v", result)
	}
	if !cache.Ready() {
		t.Fatal("收到非空快照后 Ready 必须为 true")
	}
	if cache.Count() != 2 {
		t.Fatalf("Count 不对：%d", cache.Count())
	}

	record, ok := cache.Verify("dz-key-two")
	if !ok {
		t.Fatal("合法 key 应该命中")
	}
	if record.KeyID != "key-2" || record.UserID != "1" || record.Name != "name-key-2" || record.Profile != "billed" {
		t.Fatalf("命中记录不对：%+v", record)
	}

	if _, ok := cache.Verify("wrong-key"); ok {
		t.Fatal("错误 key 不应命中")
	}
	if _, ok := cache.Verify(""); ok {
		t.Fatal("空 key 不应命中")
	}
	if _, ok := cache.Verify(" dz-key-one"); ok {
		t.Fatal("前导空白不应命中")
	}
	if _, ok := cache.Verify("dz-key-one "); ok {
		t.Fatal("尾随空白不应命中")
	}
	if _, ok := cache.Verify(strings.ToUpper("dz-key-one")); ok {
		t.Fatal("key 必须大小写敏感")
	}
}

func TestHashIsNormalizedToLowercase(t *testing.T) {
	cache := New()
	key := keyRecord("key-1", "dz-case-key")
	key.KeyHash = strings.ToUpper(key.KeyHash)
	if _, err := cache.Replace(snapshot(key)); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	if _, ok := cache.Verify("dz-case-key"); !ok {
		t.Fatal("大写 hex 哈希应被规范化后命中")
	}
}

func TestReplaceIsAtomic(t *testing.T) {
	cache := New()
	if _, err := cache.Replace(snapshot(keyRecord("key-1", "dz-one"))); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	bad := snapshot(keyRecord("key-2", "dz-two"))
	bad.Keys = append(bad.Keys, keyRecord("key-2", "dz-three"))
	if _, err := cache.Replace(bad); err == nil {
		t.Fatal("重复 keyId 必须整份拒绝")
	}
	if _, ok := cache.Verify("dz-two"); ok {
		t.Fatal("拒绝的快照不应部分应用")
	}
	if _, ok := cache.Verify("dz-one"); !ok {
		t.Fatal("旧快照必须保留")
	}
	if cache.Count() != 1 {
		t.Fatalf("计数应保持旧值：%d", cache.Count())
	}
}

func TestReplaceRejectsInvalidSnapshots(t *testing.T) {
	valid := keyRecord("key-1", "dz-one")

	cases := []struct {
		name     string
		snapshot Snapshot
		code     string
	}{
		{
			name:     "wrong version",
			snapshot: Snapshot{Version: 2, Keys: []Key{valid}},
			code:     CodeInvalidSnapshot,
		},
		{
			name:     "missing version",
			snapshot: Snapshot{Version: 0, Keys: []Key{valid}},
			code:     CodeInvalidSnapshot,
		},
		{
			name:     "negative generation",
			snapshot: Snapshot{Version: SnapshotVersion, Generation: -1, Keys: []Key{valid}},
			code:     CodeInvalidSnapshot,
		},
		{
			name: "empty key id",
			snapshot: Snapshot{Version: SnapshotVersion, Keys: []Key{
				{UserID: 1, KeyHash: hashOf("x"), Profile: "billed"},
			}},
			code: CodeInvalidKey,
		},
		{
			name: "zero user id",
			snapshot: Snapshot{Version: SnapshotVersion, Keys: []Key{
				{KeyID: "k", UserID: 0, KeyHash: hashOf("x"), Profile: "billed"},
			}},
			code: CodeInvalidKey,
		},
		{
			name: "empty profile",
			snapshot: Snapshot{Version: SnapshotVersion, Keys: []Key{
				{KeyID: "k", UserID: 1, KeyHash: hashOf("x")},
			}},
			code: CodeInvalidKey,
		},
		{
			name: "bad hash length",
			snapshot: Snapshot{Version: SnapshotVersion, Keys: []Key{
				{KeyID: "k", UserID: 1, KeyHash: "abc", Profile: "billed"},
			}},
			code: CodeInvalidKey,
		},
		{
			name: "bad hash hex",
			snapshot: Snapshot{Version: SnapshotVersion, Keys: []Key{
				{KeyID: "k", UserID: 1, KeyHash: strings.Repeat("z", 64), Profile: "billed"},
			}},
			code: CodeInvalidKey,
		},
		{
			name: "duplicate hash",
			snapshot: Snapshot{Version: SnapshotVersion, Keys: []Key{
				keyRecord("key-1", "same"),
				keyRecord("key-2", "same"),
			}},
			code: CodeDuplicateKey,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cache := New()
			if _, err := cache.Replace(tc.snapshot); err == nil {
				t.Fatal("非法快照必须被拒绝")
			} else if typed, ok := err.(*Error); !ok || typed.Code != tc.code {
				t.Fatalf("错误码不对：%v", err)
			}
		})
	}
}

func TestStatusAndResultDoNotContainHashes(t *testing.T) {
	cache := New()
	secret := "dz-super-secret-value"
	hash := hashOf(secret)
	if _, err := cache.Replace(snapshot(keyRecord("key-1", secret))); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	for name, value := range map[string]any{
		"status": cache.Status(),
		"result": Result{Revision: cache.Status().Revision, Keys: 1},
	} {
		payload, err := json.Marshal(value)
		if err != nil {
			t.Fatalf("Marshal %s: %v", name, err)
		}
		text := string(payload)
		if strings.Contains(text, secret) || strings.Contains(text, hash) {
			t.Fatalf("%s 泄漏了 key/hash：%s", name, text)
		}
	}
}

func TestEmptySnapshotIsReadyAndRejectsAll(t *testing.T) {
	cache := New()
	// 先放一份非空快照，确认空快照会把它原子替换掉。
	if _, err := cache.Replace(snapshot(keyRecord("key-1", "dz-old"))); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	if _, ok := cache.Verify("dz-old"); !ok {
		t.Fatal("替换前旧 key 应命中")
	}

	result, err := cache.Replace(Snapshot{Version: SnapshotVersion, Keys: []Key{}})
	if err != nil {
		t.Fatalf("空快照应被接受：%v", err)
	}
	if !cache.Ready() {
		t.Fatal("合法空快照也必须让 Ready 为 true（fail-closed）")
	}
	if result.Keys != 0 || cache.Count() != 0 || cache.Status().Keys != 0 {
		t.Fatalf("空快照计数应为 0：result=%+v count=%d status=%+v",
			result, cache.Count(), cache.Status())
	}
	if cache.Status().Revision == "" {
		t.Fatal("空快照也应有 revision")
	}
	if _, ok := cache.Verify("dz-old"); ok {
		t.Fatal("收到空快照后旧 key 必须失效")
	}
	if _, ok := cache.Verify("anything"); ok {
		t.Fatal("收到空快照后任何 key 都必须被拒绝")
	}
}

func TestConcurrentReadersAndWriters(t *testing.T) {
	cache := New()
	if _, err := cache.Replace(snapshot(keyRecord("key-0", "dz-0"))); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	var wg sync.WaitGroup
	for writer := 0; writer < 4; writer++ {
		wg.Add(1)
		go func(writer int) {
			defer wg.Done()
			for index := 0; index < 200; index++ {
				id := fmt.Sprintf("key-%d", (writer*200+index)%16)
				snapshot := snapshot(keyRecord(id, "dz-"+id))
				snapshot.Generation = int64(index)
				if _, err := cache.Replace(snapshot); err != nil {
					t.Errorf("Replace: %v", err)
					return
				}
			}
		}(writer)
	}
	for reader := 0; reader < 32; reader++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := 0; index < 500; index++ {
				_, _ = cache.Verify("dz-key-0")
				_ = cache.Count()
				_ = cache.Status()
			}
		}()
	}
	wg.Wait()
}
