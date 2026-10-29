package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// Session 是本机保存的会话凭据（~/.dizzy/credentials.json）。
//
// 只存**会话 token**（HttpOnly cookie 的值）与过期时间。
//
// **API key 不在这里**：owner 的硬边界写明 API key「不得落盘」，只允许从
// 环境变量或 --key 参数读。
type Session struct {
	// Token 是会话 token（对应 api 插件的 HttpOnly cookie）。
	Token string `json:"token"`
	// ExpiresAt 是会话过期时间（RFC3339）。空 = 未知。
	ExpiresAt string `json:"expiresAt,omitempty"`
	// Email 是登录时的邮箱，只为 `whoami` 之类做展示兜底。
	Email string `json:"email,omitempty"`
}

// Credentials 是凭据文件的形状。当前只有会话；API key 永不落盘。
type Credentials struct {
	Session *Session `json:"session,omitempty"`
}

// ErrCredentialsMissing 表示本机没有可用的会话。
var ErrCredentialsMissing = errors.New("没有登录凭据")

// LoadCredentials 读凭据文件。文件不存在时返回空凭据（不是错误）。
func LoadCredentials() (Credentials, error) {
	path, err := credentialsPath()
	if err != nil {
		return Credentials{}, err
	}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return Credentials{}, nil
	}
	if err != nil {
		return Credentials{}, fmt.Errorf("读取凭据 %s 失败：%w", path, err)
	}
	var credentials Credentials
	if err := json.Unmarshal(raw, &credentials); err != nil {
		return Credentials{}, fmt.Errorf("凭据文件 %s 不是合法 JSON：%w", path, err)
	}
	return credentials, nil
}

// SaveCredentials 原子写凭据文件，权限 0600。
func SaveCredentials(credentials Credentials) error {
	dir, err := configDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, dirMode); err != nil {
		return fmt.Errorf("创建配置目录 %s 失败：%w", dir, err)
	}
	payload, err := json.MarshalIndent(credentials, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化凭据失败：%w", err)
	}
	payload = append(payload, '\n')
	return writeFileAtomic(filepath.Join(dir, credentialsFileName), payload, credentialsFileMode)
}

// ClearCredentials 删掉凭据文件（登出）。
//
// 文件不存在算成功（登出幂等）。
func ClearCredentials() error {
	path, err := credentialsPath()
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("删除凭据 %s 失败：%w", path, err)
	}
	return nil
}

// SessionToken 返回本机会话 token；没有则返回 ErrCredentialsMissing。
func SessionToken() (string, error) {
	credentials, err := LoadCredentials()
	if err != nil {
		return "", err
	}
	if credentials.Session == nil || credentials.Session.Token == "" {
		return "", ErrCredentialsMissing
	}
	return credentials.Session.Token, nil
}
