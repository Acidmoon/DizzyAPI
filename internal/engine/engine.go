// Package engine 是 LLM 请求链路的执行者（AGENTS.md §2.2 / §2.4 / §6）。
//
// 它不做业务：只按显式相位（pre → dispatch → post）顺序调用已注册的阶段，
// 把阶段错误统一渲染成 HTTP 响应，并保证 post 在所有出口恰好执行一次。
//
// engine 是 cordis「启用集」的落点：描述符与启用集尚未实现（§6 仍是目标），
// 当前由组合根按注册顺序传入固定阶段集；去模块化仍是 main.go 去掉一行 Register。
package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/Acidmoon/DizzyAPI/contracts"
)

// Engine 持有一条装配好的阶段链。构造后只读，可被并发调用。
type Engine struct {
	pre      []contracts.Stage
	dispatch []contracts.Stage
	post     []contracts.Stage
	logger   *slog.Logger
}

// New 校验相位顺序并构造 engine。
//
// 注册顺序必须满足 pre → dispatch → post；相位回退视为装配错误。
// 至少需要一个 dispatch 阶段（transport），否则网关只能拒绝请求。
func New(stages []contracts.Stage, logger *slog.Logger) (*Engine, error) {
	if logger == nil {
		logger = slog.Default()
	}
	e := &Engine{logger: logger}
	lastRank := -1
	seen := make(map[string]struct{}, len(stages))
	for _, stage := range stages {
		if stage == nil {
			return nil, errors.New("engine: 阶段不能为 nil")
		}
		name := stage.Name()
		if name == "" {
			return nil, errors.New("engine: 阶段必须有名字")
		}
		if _, exists := seen[name]; exists {
			return nil, fmt.Errorf("engine: 阶段 %q 重复注册", name)
		}
		seen[name] = struct{}{}

		rank := phaseRank(stage.Phase())
		if rank < 0 {
			return nil, fmt.Errorf("engine: 阶段 %q 的相位 %v 未知", name, stage.Phase())
		}
		if rank < lastRank {
			return nil, fmt.Errorf("engine: 阶段 %q 的相位顺序非法（阶段必须按 pre → dispatch → post 注册）", name)
		}
		lastRank = rank

		switch stage.Phase() {
		case contracts.PhasePre:
			e.pre = append(e.pre, stage)
		case contracts.PhaseDispatch:
			e.dispatch = append(e.dispatch, stage)
		case contracts.PhasePost:
			e.post = append(e.post, stage)
		}
	}
	if len(e.dispatch) == 0 {
		return nil, errors.New("engine: 至少需要一个 dispatch 阶段（transport）")
	}
	return e, nil
}

func phaseRank(phase contracts.Phase) int {
	switch phase {
	case contracts.PhasePre:
		return 0
	case contracts.PhaseDispatch:
		return 1
	case contracts.PhasePost:
		return 2
	default:
		return -1
	}
}

// Run 执行一条 LLM 请求并返回最终响应决定。
//
// 规则：
//   - pre 阶段按注册顺序执行；任一阶段返回 ActionRespond 即跳过 dispatch；
//   - dispatch 在排好序的账号之间做失败转移循环，只对 Retryable 错误换账号；
//   - post 在所有出口（成功 / 拒绝 / 上游失败 / panic）恰好执行一次；
//   - 任何错误都由 engine 渲染成 HTTP 响应，模块不自己写响应。
func (e *Engine) Run(ctx *contracts.Ctx) (decision contracts.Decision) {
	if ctx == nil {
		return e.render(contracts.Errorf(http.StatusInternalServerError, "GATEWAY_INTERNAL", "请求上下文为空"))
	}
	if ctx.Context == nil {
		ctx.Context = context.Background()
	}

	defer func() {
		// post 必须在所有出口执行一次；它不能改变已经确定的响应，
		// 失败只记日志（结算类阶段的失败策略尚未按描述符实现）。
		if recovered := recover(); recovered != nil {
			e.logger.Error("LLM 请求链路 panic", "reqId", ctx.ReqID, "error", fmt.Sprintf("%v", recovered))
			decision = e.render(contracts.Errorf(http.StatusInternalServerError, "GATEWAY_INTERNAL", "网关内部错误"))
		}
		e.runPost(ctx)
	}()

	for _, stage := range e.pre {
		result, err := stage.Run(ctx)
		if err != nil {
			e.logger.Warn("pre 阶段失败", "reqId", ctx.ReqID, "stage", stage.Name(), "code", errorCode(err))
			return e.render(err)
		}
		if result.Action == contracts.ActionRespond {
			return normalize(result)
		}
	}

	return e.runDispatch(ctx)
}

// runDispatch 在候选账号上执行 dispatch 阶段，失败转移发生在这一层。
// transport 因此不需要知道「号池」这个概念（D17）。
func (e *Engine) runDispatch(ctx *contracts.Ctx) contracts.Decision {
	attempts := rankedAccounts(ctx)
	if len(attempts) == 0 {
		return e.render(contracts.Errorf(http.StatusServiceUnavailable, "NO_ELIGIBLE_ACCOUNT", "没有可用账号"))
	}

	var lastErr error
	for index, scored := range attempts {
		ctx.AccountRoute.Picked = &attempts[index]
		hasMore := index < len(attempts)-1
		responded := false

		for _, stage := range e.dispatch {
			result, err := stage.Run(ctx)
			if err != nil {
				lastErr = err
				ctx.Attempts = append(ctx.Attempts, contracts.AccountAttempt{
					AccountID: scored.AccountID,
					Status:    statusOf(err),
					Code:      errorCode(err),
				})
				if hasMore && isRetryable(err) {
					e.logger.Warn("上游尝试失败，换下一个账号",
						"reqId", ctx.ReqID, "stage", stage.Name(),
						"accountId", scored.AccountID, "code", errorCode(err))
					break
				}
				return e.render(err)
			}

			ctx.Attempts = append(ctx.Attempts, contracts.AccountAttempt{
				AccountID: scored.AccountID,
				Status:    result.Status,
			})
			if result.Action == contracts.ActionRespond {
				return normalize(result)
			}
			responded = true
		}

		if responded && lastErr == nil {
			// 所有 dispatch 阶段都返回 Continue：没有任何阶段产生响应。
			return e.render(contracts.Errorf(http.StatusBadGateway, "NO_GATEWAY_RESPONSE", "上游没有返回响应"))
		}
	}

	if lastErr != nil {
		return e.render(lastErr)
	}
	return e.render(contracts.Errorf(http.StatusBadGateway, "NO_GATEWAY_RESPONSE", "上游没有返回响应"))
}

func rankedAccounts(ctx *contracts.Ctx) []contracts.ScoredAccount {
	if ctx.AccountRoute == nil {
		return nil
	}
	if len(ctx.AccountRoute.Ranked) > 0 {
		return ctx.AccountRoute.Ranked
	}
	if ctx.AccountRoute.Picked != nil {
		return []contracts.ScoredAccount{*ctx.AccountRoute.Picked}
	}
	return nil
}

func (e *Engine) runPost(ctx *contracts.Ctx) {
	for _, stage := range e.post {
		func() {
			defer func() {
				if recovered := recover(); recovered != nil {
					e.logger.Error("post 阶段 panic", "reqId", ctx.ReqID, "stage", stage.Name(), "error", fmt.Sprintf("%v", recovered))
				}
			}()
			if _, err := stage.Run(ctx); err != nil {
				// post 阶段的错误不改变已经写出的响应；结算失败策略要等描述符。
				e.logger.Warn("post 阶段失败", "reqId", ctx.ReqID, "stage", stage.Name(), "code", errorCode(err))
			}
		}()
	}
}

func normalize(decision contracts.Decision) contracts.Decision {
	if decision.Status == 0 {
		decision.Status = http.StatusOK
	}
	if decision.Action != contracts.ActionRespond {
		decision.Action = contracts.ActionRespond
	}
	return decision
}

// render 把错误渲染成 OpenAI 兼容的错误响应。
// 只有 StageError / PublicError 的 message 会外露；其他错误一律吞掉。
func (e *Engine) render(err error) contracts.Decision {
	if err == nil {
		err = contracts.Errorf(http.StatusInternalServerError, "GATEWAY_INTERNAL", "网关内部错误")
	}

	status := http.StatusInternalServerError
	code := "GATEWAY_INTERNAL"
	message := "网关内部错误"

	var stageErr *contracts.StageError
	var publicErr contracts.PublicError
	switch {
	case errors.As(err, &stageErr):
		status = stageErr.Status
		code = stageErr.Code
		message = stageErr.Message
		e.logger.Warn("LLM 请求失败", "code", code, "status", status, "message", message)
	case errors.As(err, &publicErr):
		status = publicErr.HTTPStatus()
		code = publicErr.ErrorCode()
		message = publicErr.PublicMessage()
		e.logger.Warn("LLM 请求失败", "code", code, "status", status, "message", message)
	default:
		// 不透传未知错误的消息：它可能包含 URL、请求体或令牌。
		e.logger.Error("LLM 请求失败（内部错误，已隐藏详情）", "errorType", fmt.Sprintf("%T", err))
	}

	if status < 400 || status > 599 {
		status = http.StatusInternalServerError
	}
	body, marshalErr := json.Marshal(map[string]any{
		"error": map[string]any{
			"message": message,
			"type":    errorType(status),
			"code":    code,
		},
	})
	if marshalErr != nil {
		body = []byte(`{"error":{"message":"网关内部错误","type":"server_error","code":"GATEWAY_INTERNAL"}}`)
	}
	return contracts.Decision{
		Action:  contracts.ActionRespond,
		Status:  status,
		Headers: map[string]string{"Content-Type": "application/json"},
		Body:    body,
	}
}

func isRetryable(err error) bool {
	var retryable contracts.RetryableError
	return errors.As(err, &retryable) && retryable.CanRetry()
}

func errorCode(err error) string {
	var stageErr *contracts.StageError
	if errors.As(err, &stageErr) {
		return stageErr.Code
	}
	var publicErr contracts.PublicError
	if errors.As(err, &publicErr) {
		return publicErr.ErrorCode()
	}
	return "GATEWAY_INTERNAL"
}

func statusOf(err error) int {
	var stageErr *contracts.StageError
	if errors.As(err, &stageErr) {
		return stageErr.Status
	}
	var publicErr contracts.PublicError
	if errors.As(err, &publicErr) {
		return publicErr.HTTPStatus()
	}
	return 0
}

func errorType(status int) string {
	switch {
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return "authentication_error"
	case status == http.StatusTooManyRequests:
		return "rate_limit_error"
	case status >= 500:
		return "server_error"
	default:
		return "invalid_request_error"
	}
}
