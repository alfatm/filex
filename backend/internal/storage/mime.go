package storage

import (
	"path/filepath"
	"strings"
)

// RefineMime repairs the two MIME types http.DetectContentType cannot get
// right from 512 bytes, using the file extension as the tie-breaker. Returns
// the input unchanged for everything else.
//
// Drivers and serving handlers call this BEFORE returning a stored or
// freshly-sniffed MIME to clients.
//
//  1. "application/zip" for an office file. OOXML/ODF documents ARE zips with
//     a manifest, so sniffing cannot tell them apart. OnlyOffice Document
//     Server then refuses a pptx/docx/odt whose fetch Content-Type says
//     "application/zip", even though the JWT-signed config says fileType=pptx
//     (xlsx happens to be lenient; the rest are not).
//
//  2. "text/plain" or "text/xml" for an SVG. An SVG has no magic number at
//     all, so every one of them is catalogued as text — which cost them their
//     thumbnail (neither SVG branch of the thumbnail dispatcher matched, and
//     the file fell through to the generic placeholder card) and makes a
//     browser refuse to render the download as an image.
func RefineMime(detected, filename string) string {
	ext := strings.ToLower(filepath.Ext(filename))
	if ext == ".svg" && isTextish(detected) {
		return "image/svg+xml"
	}
	if detected != "application/zip" {
		return detected
	}
	switch ext {
	case ".docx":
		return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	case ".xlsx":
		return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	case ".pptx":
		return "application/vnd.openxmlformats-officedocument.presentationml.presentation"
	case ".odt":
		return "application/vnd.oasis.opendocument.text"
	case ".ods":
		return "application/vnd.oasis.opendocument.spreadsheet"
	case ".odp":
		return "application/vnd.oasis.opendocument.presentation"
	}
	return detected
}

// isTextish reports whether a sniffed MIME is one of the generic text answers
// http.DetectContentType falls back to for markup — the only values an .svg
// may be overridden from. A .svg carrying real image magic bytes (someone
// renamed a PNG) keeps the type its BYTES say it is.
func isTextish(detected string) bool {
	base, _, _ := strings.Cut(detected, ";")
	switch strings.TrimSpace(strings.ToLower(base)) {
	case "text/plain", "text/xml", "application/xml", "text/html":
		return true
	}
	return false
}
