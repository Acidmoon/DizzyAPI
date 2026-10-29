// Package contentaudit 是 pre 相位的内容审核闸门：用规则快照检查用户输入文本，
// 命中 block 规则直接拒绝，命中 log 规则只记日志与计数。
//
// 边界（AGENTS.md §2.3）：
//   - 只 import `contracts`：规则来源由消费者定义的小接口注入（main.go 组装），
//     不 import `internal/contentaudit` 或任何其它模块；
//   - 只读：不改规则、不写存储、不发桥消息；
//   - **只审用户输入文本**：不审 system / assistant / 工具结果，也不审响应；
//   - 文本提取自己写：`modules/*` 之间零 import，不能借 protoconv 的 codec；
//   - 解析失败、没有可审文本、快照未就绪都**放行**（可用性优先），并计数 + 告警；
//     严格模式（`-content-audit-require-snapshot`）下快照不可用才 503。
package contentaudit

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

const (
	// StageName 是阶段名（日志与注册用）。
	StageName = "content-audit"
	// DefaultWarnInterval 是「同一原因告警」的最小间隔。
	DefaultWarnInterval = time.Minute
	// staleLogEvery 是「持续失效」的里程碑步长。
	staleLogEvery = 10
	// sustainedLogInterval 是里程碑告警的最小间隔，防止高 QPS 下每 10 次刷一行。
	sustainedLogInterval = 5 * time.Second
	// maxScanBytes 是单次请求最多扫描的文本字节数。
	//
	// 审核是 best-effort：请求体上限是 32 MiB，逐条规则扫全量会拖慢热路径；
	// 这里按「所有待审文本合计」截断，并在统计里记 `truncated`（不静默）。
	maxScanBytes = 256 << 10
	// maxTexts 是一次请求最多收集多少段文本（防御性上限）。
	maxTexts = 256
	// maxRuleHits 是命中统计表的上限（规则数量本身有上限，这里再兜一层）。
	maxRuleHits = 1024
)

// Rules 是消费者定义的只读规则快照接口。实现是 `internal/contentaudit.Cache`。
type Rules interface {
	// Ready 表示是否已经收到过至少一份合法快照。
	Ready() bool
	// Age 返回当前快照的年龄（没有快照时为 0）。
	Age() time.Duration
	// TTL 返回快照有效期。
	TTL() time.Duration
	// Enabled 报告快照里审核是否开启。
	Enabled() bool
	// Match 用当前规则匹配一组文本，返回命中的规则（不含被审文本）。
	Match(texts []string) []contracts.ContentAuditHit
}

// Config 是内容审核的配置。非法值由 Register 明确拒绝（组合根让进程起不来）。
type Config struct {
	// RequireSnapshot 打开严格模式：快照未就绪 / 过期时返回 503，而不是放行。
	RequireSnapshot bool
	// SnapshotTTL 是快照有效期，必须 > 0。默认取规则缓存自己的 TTL。
	SnapshotTTL time.Duration
}

// Stage 是内容审核的 pre 阶段。
type Stage struct {
	rules        Rules
	config       Config
	logger       *slog.Logger
	now          func() time.Time
	warnInterval time.Duration
	mu           sync.Mutex
	lastWarn     map[string]time.Time
	ruleHits     map[string]int
	blocked      int
	logged       int
	allowedStale int
	strictFailed int
	parseFailed  int
	noText       int
	truncated    int
	staleStreak  int
	staleReason  string
	staleSince   time.Time
	staleFor     time.Duration
}

// Register 校验配置并注册阶段。rules 为 nil 表示没有运行时规则来源：
// 严格模式下等于「快照永远不可用」，默认模式下等于永不审核。
func Register(reg *contracts.Registry, cfg Config, rules Rules, logger *slog.Logger) (*Stage, error) {
	if reg == nil {
		return nil, contracts.Errorf(http.StatusInternalServerError, "CONTENT_AUDIT_INVALID_CONFIG",
			"Registry 不能为空")
	}
	if cfg.SnapshotTTL < 0 {
		return nil, contracts.Errorf(http.StatusInternalServerError, "CONTENT_AUDIT_INVALID_CONFIG",
			"快照有效期不能为负数")
	}
	if cfg.SnapshotTTL == 0 && rules != nil {
		cfg.SnapshotTTL = rules.TTL()
	}
	stage := New(cfg, rules, logger)
	reg.Stage(stage)
	return stage, nil
}

// New 构造阶段（不注册；测试与手工组装用）。
func New(cfg Config, rules Rules, logger *slog.Logger) *Stage {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	return &Stage{
		rules:        rules,
		config:       cfg,
		logger:       logger,
		now:          time.Now,
		warnInterval: DefaultWarnInterval,
		lastWarn:     make(map[string]time.Time),
		ruleHits:     make(map[string]int),
	}
}

func (s *Stage) Name() string { return StageName }

func (s *Stage) Phase() contracts.Phase { return contracts.PhasePre }

func (s *Stage) Required() bool { return true }

// NeedBody 为真：审核要看请求体。
func (s *Stage) NeedBody() bool { return true }

// Run 做一次内容审核。
func (s *Stage) Run(ctx *contracts.Ctx) (contracts.Decision, error) {
	continueOn := contracts.Decision{Action: contracts.ActionContinue}
	if ctx == nil {
		return continueOn, nil
	}

	if s.snapshotUnavailable() {
		streak, since := s.noteStale("snapshot-unavailable")
		if s.config.RequireSnapshot {
			s.warn(ctx, "snapshot-unavailable", streak, since, "内容审核快照不可用，严格模式拒绝请求")
			s.countStrict()
			return contracts.Decision{}, contracts.Errorf(http.StatusServiceUnavailable,
				contracts.CodeContentAuditSnapshotUnavailable,
				"内容审核规则暂时不可用，请稍后重试")
		}
		s.warn(ctx, "snapshot-unavailable", streak, since, "内容审核快照不可用，本请求放行")
		s.countAllowedStale()
		return continueOn, nil
	}
	// 快照新鲜：连续不可用的观察清零。
	s.noteHealthy()

	if !s.rules.Enabled() {
		// 审核整体关闭：Go 侧全放行（TS 会推 enabled=false + 空规则）。
		return continueOn, nil
	}

	body, err := ctx.Body.Bytes()
	if err != nil {
		s.countParseFailed()
		s.warn(ctx, "body-unreadable", 0, time.Time{}, "内容审核读不到请求体，本请求放行")
		return continueOn, nil
	}
	texts, truncated, extractErr := ExtractTexts(body, ctx.ClientProtocol, ctx.Operation)
	if extractErr != nil {
		s.countParseFailed()
		s.warn(ctx, "parse-failed", 0, time.Time{}, "内容审核解析请求体失败，本请求放行", "error", extractErr.Error())
		return continueOn, nil
	}
	if truncated {
		s.countTruncated()
	}
	if len(texts) == 0 {
		s.countNoText()
		return continueOn, nil
	}

	hits := s.rules.Match(texts)
	if len(hits) == 0 {
		return continueOn, nil
	}

	blockedRule := ""
	for _, hit := range hits {
		s.recordHit(hit.RuleID)
		if hit.Action == contracts.ContentAuditActionBlock {
			if blockedRule == "" {
				blockedRule = hit.RuleID
			}
			continue
		}
		s.countLogged()
		// 只记规则 id 与分类：绝不回显用户输入（AGENTS.md §5.1）。
		s.warn(ctx, "rule-log:"+hit.RuleID, 0, time.Time{},
			"内容审核命中规则（log，已放行）", "ruleId", hit.RuleID, "category", hit.Category)
	}
	if blockedRule == "" {
		return continueOn, nil
	}

	s.countBlocked()
	s.warn(ctx, "rule-block:"+blockedRule, 0, time.Time{},
		"内容审核命中规则，拒绝请求", "ruleId", blockedRule)
	// 403、不可重试：换账号也没用，内容本身被拒。
	return contracts.Decision{}, contracts.Errorf(http.StatusForbidden,
		contracts.CodeContentBlocked, "请求内容命中内容审核规则，已被拒绝")
}

// Stats 是阶段自身的计数（排障用，不含任何被审文本）。
type Stats struct {
	Blocked      int
	Logged       int
	AllowedStale int
	StrictFailed int
	ParseFailed  int
	NoText       int
	Truncated    int
	StaleStreak  int
	StaleReason  string
	StaleForMs   int64
	RuleHits     map[string]int
	RuleHitTotal int
}

// Stats 返回计数快照（RuleHits 是副本）。
func (s *Stage) Stats() Stats {
	s.mu.Lock()
	defer s.mu.Unlock()
	staleFor := s.staleFor
	if s.staleStreak > 0 && s.now != nil {
		staleFor = s.now().Sub(s.staleSince)
	}
	hits := make(map[string]int, len(s.ruleHits))
	total := 0
	for id, count := range s.ruleHits {
		hits[id] = count
		total += count
	}
	return Stats{
		Blocked:      s.blocked,
		Logged:       s.logged,
		AllowedStale: s.allowedStale,
		StrictFailed: s.strictFailed,
		ParseFailed:  s.parseFailed,
		NoText:       s.noText,
		Truncated:    s.truncated,
		StaleStreak:  s.staleStreak,
		StaleReason:  s.staleReason,
		StaleForMs:   staleFor.Milliseconds(),
		RuleHits:     hits,
		RuleHitTotal: total,
	}
}

// snapshotUnavailable 判断「没有可用快照」：没收到、或超过 TTL。
func (s *Stage) snapshotUnavailable() bool {
	if s.rules == nil || !s.rules.Ready() {
		return true
	}
	ttl := s.config.SnapshotTTL
	if ttl <= 0 {
		ttl = s.rules.TTL()
	}
	if ttl <= 0 {
		return false
	}
	return s.rules.Age() > ttl
}

// noteStale 记一次「快照不可用」的观察，返回连续次数与起始时间。
func (s *Stage) noteStale(reason string) (int, time.Time) {
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.staleStreak == 0 || s.staleReason != reason {
		s.staleStreak = 0
		s.staleReason = reason
		s.staleSince = now
	}
	s.staleStreak += 1
	s.staleFor = now.Sub(s.staleSince)
	return s.staleStreak, s.staleSince
}

// noteHealthy 在快照新鲜时清零连续不可用的观察。
func (s *Stage) noteHealthy() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.staleStreak = 0
	s.staleReason = ""
	s.staleSince = time.Time{}
	s.staleFor = 0
}

// warn 按原因节流，并区分「偶发」与「持续」：第 1 次立即报；之后每分钟一条；
// 连续第 10 / 20… 次（≥5s 间隔）即使还在窗口内也补一条并标注「持续失效」。
func (s *Stage) warn(ctx *contracts.Ctx, reason string, streak int, since time.Time, message string, args ...any) {
	now := s.now()
	s.mu.Lock()
	last, seen := s.lastWarn[reason]
	sustained := streak > 1 && streak%staleLogEvery == 0 && (!seen || now.Sub(last) >= sustainedLogInterval)
	if streak != 1 && seen && now.Sub(last) < s.warnInterval && !sustained {
		s.mu.Unlock()
		return
	}
	s.lastWarn[reason] = now
	s.mu.Unlock()

	fields := []any{"reqId", ctx.ReqID, "code", reason}
	if streak > 1 {
		fields = append(fields, "staleStreak", streak)
		if !since.IsZero() {
			fields = append(fields, "staleForMs", now.Sub(since).Milliseconds())
		}
		message = message + "（持续失效）"
	}
	s.logger.Warn(message, append(fields, args...)...)
}

func (s *Stage) recordHit(ruleID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.ruleHits[ruleID]; !exists && len(s.ruleHits) >= maxRuleHits {
		return
	}
	s.ruleHits[ruleID]++
}

func (s *Stage) countBlocked()      { s.mu.Lock(); s.blocked += 1; s.mu.Unlock() }
func (s *Stage) countLogged()       { s.mu.Lock(); s.logged += 1; s.mu.Unlock() }
func (s *Stage) countAllowedStale() { s.mu.Lock(); s.allowedStale += 1; s.mu.Unlock() }
func (s *Stage) countStrict()       { s.mu.Lock(); s.strictFailed += 1; s.mu.Unlock() }
func (s *Stage) countParseFailed()  { s.mu.Lock(); s.parseFailed += 1; s.mu.Unlock() }
func (s *Stage) countNoText()       { s.mu.Lock(); s.noText += 1; s.mu.Unlock() }
func (s *Stage) countTruncated()    { s.mu.Lock(); s.truncated += 1; s.mu.Unlock() }

// ExtractTexts 从请求体里提取**用户输入文本**，按客户端协议与操作类型分派。
//
// 只审用户说的话：system / assistant / 工具结果一律不审（它们不是用户输入，
// 而且跨协议形状差异大，误伤成本高）。
//
// 返回值：待审文本、是否因超过 maxScanBytes 被截断、解析错误。
// 解析失败由调用方决定放行（本函数不 panic）。
func ExtractTexts(body []byte, protocol contracts.Protocol, operation contracts.Operation) ([]string, bool, error) {
	if len(body) == 0 {
		return nil, false, nil
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, false, err
	}
	if payload == nil {
		return nil, false, nil
	}

	var texts []string
	switch {
	case operation.IsEmbeddings():
		texts = appendEmbeddingsTexts(texts, payload["input"])
	case protocol == contracts.ProtocolOpenAIChat, protocol == contracts.ProtocolAnthropic:
		texts = appendChatTexts(texts, payload["messages"])
	case protocol == contracts.ProtocolOpenAIResponses:
		texts = appendResponsesTexts(texts, payload["input"])
	case protocol == contracts.ProtocolGemini:
		texts = appendGeminiTexts(texts, payload["contents"])
	default:
		// 未知客户端协议（旧路径）：不审，交给后面的阶段。
		return nil, false, nil
	}
	kept, truncated := capScan(texts)
	return kept, truncated, nil
}

func appendEmbeddingsTexts(texts []string, raw json.RawMessage) []string {
	if len(raw) == 0 {
		return texts
	}
	var single string
	if err := json.Unmarshal(raw, &single); err == nil {
		return appendText(texts, single)
	}
	var list []string
	if err := json.Unmarshal(raw, &list); err == nil {
		for _, item := range list {
			texts = appendText(texts, item)
		}
	}
	return texts
}

func appendChatTexts(texts []string, raw json.RawMessage) []string {
	if len(raw) == 0 {
		return texts
	}
	var messages []struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	}
	if err := json.Unmarshal(raw, &messages); err != nil {
		return texts
	}
	for _, message := range messages {
		if message.Role != "user" {
			continue
		}
		texts = appendContentParts(texts, message.Content)
	}
	return texts
}

func appendResponsesTexts(texts []string, raw json.RawMessage) []string {
	if len(raw) == 0 {
		return texts
	}
	var single string
	if err := json.Unmarshal(raw, &single); err == nil {
		return appendText(texts, single)
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return texts
	}
	for _, item := range items {
		var entry struct {
			Type    string          `json:"type"`
			Role    string          `json:"role"`
			Text    string          `json:"text"`
			Content json.RawMessage `json:"content"`
		}
		if err := json.Unmarshal(item, &entry); err != nil {
			continue
		}
		// 纯文本 item：`{type:"input_text", text}`。
		if entry.Text != "" {
			texts = appendText(texts, entry.Text)
			continue
		}
		if entry.Content == nil {
			continue
		}
		// 消息 item：`{type:"message", role:"user", content:[...]}`；没有 role 的按用户输入处理
		// （Responses 的 input 数组本身就是用户输入流）。
		if entry.Role != "" && entry.Role != "user" {
			continue
		}
		texts = appendContentParts(texts, entry.Content)
	}
	return texts
}

func appendGeminiTexts(texts []string, raw json.RawMessage) []string {
	if len(raw) == 0 {
		return texts
	}
	var contents []struct {
		Role  string `json:"role"`
		Parts []struct {
			Text string `json:"text"`
		} `json:"parts"`
	}
	if err := json.Unmarshal(raw, &contents); err != nil {
		return texts
	}
	for _, content := range contents {
		// Gemini 的用户轮次是 role:"user"（缺省 role 也是 user）。
		if content.Role != "" && content.Role != "user" {
			continue
		}
		for _, part := range content.Parts {
			texts = appendText(texts, part.Text)
		}
	}
	return texts
}

// appendContentParts 处理 `content` 的两种形态：字符串，或 parts 数组（取 text 字段）。
func appendContentParts(texts []string, raw json.RawMessage) []string {
	if len(raw) == 0 {
		return texts
	}
	var single string
	if err := json.Unmarshal(raw, &single); err == nil {
		return appendText(texts, single)
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &parts); err != nil {
		return texts
	}
	for _, part := range parts {
		// 只取文本 part：图片 / 音频 part 没有 text 字段，自动跳过。
		if part.Text == "" {
			continue
		}
		texts = appendText(texts, part.Text)
	}
	return texts
}

func appendText(texts []string, text string) []string {
	if text == "" || len(texts) >= maxTexts {
		return texts
	}
	return append(texts, text)
}

// capScan 把待审文本合计截到 maxScanBytes，避免超长请求拖慢热路径。
func capScan(texts []string) ([]string, bool) {
	total := 0
	kept := make([]string, 0, len(texts))
	truncated := false
	for _, text := range texts {
		if total+len(text) > maxScanBytes {
			remaining := maxScanBytes - total
			if remaining > 0 {
				kept = append(kept, text[:remaining])
				total += remaining
			}
			truncated = true
			break
		}
		kept = append(kept, text)
		total += len(text)
	}
	return kept, truncated
}
