package runcontrol

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseSignalExplicitNoProse(t *testing.T) {
	if ParseSignalExplicit("mission complete") != "" {
		t.Fatal("prose must not be a signal")
	}
	if ParseSignalExplicit("HOST: DONE") != SignalDone {
		t.Fatal("HOST: DONE")
	}
	if ParseSignalExplicit(`{"signal":"STOP"}`) != SignalStop {
		t.Fatal("json STOP")
	}
}

func TestEffectiveMergeEmptyContinuesByDefault(t *testing.T) {
	sig, merge, empty := EffectiveMerge("", true)
	if sig != SignalContinue || !merge || !empty {
		t.Fatalf("empty+defaultMerge must CONTINUE: %q merge=%v empty=%v", sig, merge, empty)
	}
	sig, merge, empty = EffectiveMerge("", false)
	if sig != SignalHold || merge || !empty {
		t.Fatalf("empty+!defaultMerge must HOLD: %q merge=%v empty=%v", sig, merge, empty)
	}
	sig, merge, empty = EffectiveMerge(SignalContinue, false)
	if sig != SignalContinue || !merge || empty {
		t.Fatalf("CONTINUE should merge: %q %v %v", sig, merge, empty)
	}
}

func TestShouldRunWorker(t *testing.T) {
	if ShouldRunWorker(SignalHold) {
		t.Fatal("HOLD no worker")
	}
	if ShouldRunWorker(SignalDone) {
		t.Fatal("DONE no worker")
	}
	if !ShouldRunWorker(SignalContinue) {
		t.Fatal("CONTINUE runs worker")
	}
}

func TestGateDone(t *testing.T) {
	_, gated, _ := GateDone(SignalDone, 2, false, "")
	if !gated {
		t.Fatal("expected gate")
	}
	sig, gated, _ := GateDone(SignalDone, 2, true, "")
	if gated || sig != SignalDone {
		t.Fatal("mission_complete should pass")
	}
}

func TestResolvePrefersFile(t *testing.T) {
	dir := t.TempDir()
	if err := WriteVerdict(dir, Verdict{Signal: "STOP", Cycle: 1}); err != nil {
		t.Fatal(err)
	}
	sig, v := ResolveSignal(dir, "HOST: DONE")
	if sig != SignalStop || v.Source != "file" {
		t.Fatalf("got %q source=%s", sig, v.Source)
	}
}

func TestAppendPhase(t *testing.T) {
	dir := t.TempDir()
	if err := AppendPhase(dir, 1, PhaseBoot, PhaseSystem, "x"); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(filepath.Join(dir, "PHASES.jsonl"))
	if !strings.Contains(string(data), "system") {
		t.Fatal(string(data))
	}
}

func TestShouldAcceptBaseline(t *testing.T) {
	if ShouldAcceptBaseline("") || ShouldAcceptBaseline(SignalHold) {
		t.Fatal("empty/hold must not accept")
	}
	if !ShouldAcceptBaseline(SignalContinue) {
		t.Fatal("CONTINUE accepts")
	}
}
