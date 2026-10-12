// Package data holds the collector's reviewed data files, embedded in the binary so a deploy cannot
// run with a different list than the one that was tested.
package data

import _ "embed"

// DatacenterASNs is data/datacenter-asns.txt.
//
//go:embed datacenter-asns.txt
var DatacenterASNs string

// IsbotPatterns is data/isbot-patterns.json (see isbot-NOTICE.md).
//
//go:embed isbot-patterns.json
var IsbotPatterns []byte
