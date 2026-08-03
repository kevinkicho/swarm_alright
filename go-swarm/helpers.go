package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
)

func environ() []string { return os.Environ() }

func splitLines(s string) []string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	return strings.Split(s, "\n")
}

func startsWith(s, prefix string) bool { return strings.HasPrefix(s, prefix) }
func indexOf(s, sub string) int        { return strings.Index(s, sub) }
func contains(s, sub string) bool      { return strings.Contains(s, sub) }
func trimSpace(s string) string        { return strings.TrimSpace(s) }
func toLower(s string) string          { return strings.ToLower(s) }
func toUpper(s string) string          { return strings.ToUpper(s) }
func hasPrefix(s, prefix string) bool  { return strings.HasPrefix(s, prefix) }
func hasSuffix(s, suffix string) bool  { return strings.HasSuffix(s, suffix) }
func split(s, sep string) []string     { return strings.Split(s, sep) }
func join(parts []string, sep string) string { return strings.Join(parts, sep) }

var httpClient = &http.Client{}

func ioReadAll(r io.Reader) ([]byte, error) {
	return io.ReadAll(r)
}

func jsonUnmarshal(data []byte, v any) error {
	return json.Unmarshal(data, v)
}

func jsonMarshal(v any) ([]byte, error) {
	return json.Marshal(v)
}

func regexpReplace(text, pattern, replacement string) string {
	re, err := regexpCompile(pattern)
	if err != nil {
		return text
	}
	return re.ReplaceAllString(text, replacement)
}

func regexpCompile(pattern string) (*regexp.Regexp, error) {
	return regexp.Compile(pattern)
}