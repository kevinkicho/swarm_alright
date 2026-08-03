package main

import "fmt"

// Version is set by goreleaser via ldflags
var version = "dev"

func main() {
	if err := Execute(); err != nil {
		fmt.Fprintf(stderr, "error: %v\n", err)
		exit(1)
	}
}