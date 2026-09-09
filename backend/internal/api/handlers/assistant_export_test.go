package handlers

// Two durations the assistant measures in seconds, opened to the tests that
// have to watch one run out. A test that waited for the real value would be
// measured in seconds too, and the behaviour on the far side of each — the
// stream saying it is still alive, the Test button naming a hung provider — is
// exactly what must not go untested.

import "time"

// SetKeepaliveInterval shortens the turn stream's keepalive and returns the
// function that puts it back.
func SetKeepaliveInterval(d time.Duration) func() {
	previous := keepaliveInterval
	keepaliveInterval = d
	return func() { keepaliveInterval = previous }
}

// SetProviderTestTimeout shortens the admin page's Test button deadline and
// returns the function that puts it back.
func SetProviderTestTimeout(d time.Duration) func() {
	previous := testTimeout
	testTimeout = d
	return func() { testTimeout = previous }
}
