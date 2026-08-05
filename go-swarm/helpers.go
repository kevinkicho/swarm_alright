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
func toLower(s string) string          { return strings.ToLower(s) }

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
	re, err := regexp.Compile(pattern)
	if err != nil {
		return text
	}
	return re.ReplaceAllString(text, replacement)
}