package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"strings"
	"time"

	"github.com/Acidmoon/DizzyAPI/internal/bridge"
	"github.com/Acidmoon/DizzyAPI/internal/usagelog"
	"github.com/Acidmoon/DizzyAPI/modules/accountpriority"
)

// 本文件是组合根的**小工具**：配置校验、桥参数解码、日志与地址检查。
// 它们和「装哪个模块」无关，从 main.go 拆出来只为让组合根本身只看装配。

// mapModuleError 把 accountpriority 的领域错误翻成桥错误码。
func mapModuleError(err error) error {
	var typed *accountpriority.Error
	if errors.As(err, &typed) {
		return bridge.Errorf(string(typed.Code), "%s", typed.Message)
	}
	return bridge.Errorf("ACCOUNT_PRIORITY_INTERNAL", "%v", err)
}

// newUsageRing 是容量配置的唯一装配点：非法值直接返回错误，让进程起不来，
// 而不是静默回落到默认容量（那样「配置写错」会看起来像「配置生效」）。
func newUsageRing(capacity int) (*usagelog.Ring, error) {
	ring, err := usagelog.NewRing(capacity)
	if err != nil {
		return nil, fmt.Errorf("用量环形缓冲容量配置（-usage-ring-capacity）非法：%w", err)
	}
	return ring, nil
}

// maxAccountCooldownMs 是账号冷却时间的上限（10 分钟）：再长就等于把账号判死刑，
// 那属于管理面停用，不是运行时冷却。
const maxAccountCooldownMs = 600_000

// parseAccountCooldown 校验账号冷却配置。0 = 关闭冷却；负数或超过上限明确失败。
func parseAccountCooldown(ms int) (time.Duration, error) {
	if ms == 0 {
		return 0, nil
	}
	if ms < 0 || ms > maxAccountCooldownMs {
		return 0, fmt.Errorf("账号冷却时间配置（-account-cooldown-ms）非法：必须在 0..%d ms 之间（0 = 关闭冷却），得到 %d",
			maxAccountCooldownMs, ms)
	}
	return time.Duration(ms) * time.Millisecond, nil
}

// decodeParams 严格解码桥参数：拒绝未知字段与末尾多余内容。
func decodeParams(raw json.RawMessage, target any) error {
	if len(bytes.TrimSpace(raw)) == 0 {
		raw = []byte("{}")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("参数末尾有多余内容")
	}
	return nil
}

// parseAPIKeys 从环境变量读取静态 key。逗号、分号、空白都算分隔符。
// 它只进内存；日志、状态与 ready 行都不会包含这些值。
func parseAPIKeys(raw string) []string {
	return strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ';' || r == '\n' || r == '\r' || r == '\t' || r == ' '
	})
}

// requireLoopback 拒绝非回环监听地址（DNS rebinding 防线）。
func requireLoopback(address string) error {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("地址 %q 不合法：%w", address, err)
	}
	switch host {
	case "127.0.0.1", "::1", "localhost":
	default:
		return fmt.Errorf("只允许回环地址，收到 %q", host)
	}
	if port == "" {
		return errors.New("必须显式给出端口")
	}
	return nil
}

// newLogger 按配置建进程日志（stdout 只放 ready 一行，日志一律走 stderr）。
func newLogger(format string) *slog.Logger {
	options := &slog.HandlerOptions{Level: slog.LevelInfo}
	if format == "json" {
		return slog.New(slog.NewJSONHandler(os.Stderr, options))
	}
	return slog.New(slog.NewTextHandler(os.Stderr, options))
}
