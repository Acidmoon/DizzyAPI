package main

import (
	"math/big"
	"strings"
)

// bigInt 是整数金额（微元）的薄封装。
//
// 用 math/big 而不是 int64 / float64：
//   - 余额与费用是**整数最小单位**（AGENTS.md §2.4.3），禁止浮点；
//   - 金额跨层是十进制字符串，可能超出 int64 的舒适范围；
//   - 累加多笔费用时不会溢出。
//
// 解析失败一律返回 false：调用方自己决定怎么处理（**不静默当 0**）。
type bigInt struct {
	value    big.Int
	negative bool
}

// newBigInt 造一个值为 0 的 bigInt。
func newBigInt() *bigInt {
	return &bigInt{}
}

// parse 解析一个十进制整数（可带负号）。
func (b *bigInt) parse(text string) (*bigInt, bool) {
	if text == "" {
		return nil, false
	}
	value, ok := new(big.Int).SetString(text, 10)
	if !ok {
		return nil, false
	}
	return &bigInt{value: *value, negative: value.Sign() < 0}, true
}

// divMod 取绝对值除以除数，返回商与余数（都非负）。
func (b *bigInt) divMod(divisor int64) (whole *bigInt, fraction *bigInt) {
	absolute := new(big.Int).Abs(&b.value)
	divider := big.NewInt(divisor)
	quotient := new(big.Int)
	remainder := new(big.Int)
	quotient.QuoRem(absolute, divider, remainder)
	return &bigInt{value: *quotient}, &bigInt{value: *remainder}
}

// add 相加两个整数。
func (b *bigInt) add(other *bigInt) *bigInt {
	sum := new(big.Int).Add(&b.value, &other.value)
	return &bigInt{value: *sum, negative: sum.Sign() < 0}
}

// text 返回十进制字符串（带符号）。
func (b *bigInt) text() string {
	return b.value.String()
}

// microsPerYuan 是 1 元对应的微元数（1 元 = 1_000_000 微元）。
//
// 与 packages/pricing/src/money.ts 的 MICROS_PER_YUAN 同口径。
const microsPerYuan = 1_000_000

// formatMicros 把整数微元渲染成「元」字符串。
//
// **全程整数运算**：微元 → 元是除以 1_000_000，余数补零到 6 位再去尾零。
// 不用 float64（AGENTS.md §2.4.3）。
//
// 解析失败时**原样返回**并标注单位：宁可显示「123abc 微元」也不显示成 0。
func formatMicros(micros string) string {
	value, ok := newBigInt().parse(micros)
	if !ok {
		return micros + " 微元"
	}
	whole, fraction := value.divMod(microsPerYuan)
	fractionText := fraction.text()
	// 余数补零到 6 位（微元的最小单位是 1/1000000 元）。
	for len(fractionText) < 6 {
		fractionText = "0" + fractionText
	}
	text := whole.text() + "." + fractionText
	text = trimFraction(text)
	// 负号只在数值确实非零时加：-0.5 要显示成 "-0.5"，而 "-0" 显示成 "0"。
	if value.negative && (whole.text() != "0" || !isZeroText(fractionText)) {
		text = "-" + text
	}
	return text + " 元"
}

// trimFraction 去掉小数部分末尾的零（整数则去掉小数点）。
func trimFraction(text string) string {
	if !strings.Contains(text, ".") {
		return text
	}
	text = strings.TrimRight(text, "0")
	return strings.TrimSuffix(text, ".")
}

// isZeroText 判断十进制字符串是不是 0（忽略符号）。
func isZeroText(text string) bool {
	for _, character := range text {
		if character != '0' && character != '-' && character != '+' {
			return false
		}
	}
	return true
}

// addMicros 把两个整数微元字符串相加。
//
// 走整数运算，不经 float64：微元是十进制字符串，可能超出 float64 的精确范围。
// 任一边解析失败就**原样返回左边**（不静默当 0 —— 那是账目错误）。
func addMicros(left, right string) string {
	leftValue, leftOK := newBigInt().parse(left)
	rightValue, rightOK := newBigInt().parse(right)
	if !leftOK || !rightOK {
		return left
	}
	return leftValue.add(rightValue).text()
}
