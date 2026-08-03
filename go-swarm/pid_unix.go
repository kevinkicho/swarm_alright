//go:build !windows

package main

func isWindowsPIDAlive(pid int) bool { return false }