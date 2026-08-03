package main

import (
	"os"
	"io"
)

var (
	stdout io.Writer = os.Stdout
	stderr io.Writer = os.Stderr
	stdin  io.Reader = os.Stdin
)

func exit(code int) { os.Exit(code) }