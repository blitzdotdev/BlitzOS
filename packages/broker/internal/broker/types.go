package broker

import (
	"io"

	"github.com/blitzdotdev/blitz-core/broker/internal/feed"
)

const (
	FeedMaxBytes      = feed.MaxBytes
	AuthorizedKeysDir = "/etc/blitz-broker/authorized_keys"
)

type Key = feed.Key
type Member = feed.Member
type Feed = feed.Feed

func DecodeFeed(reader io.Reader) (Feed, error) {
	return feed.Decode(reader)
}
