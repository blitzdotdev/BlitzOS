package broker

import (
	"errors"
	"io"
	"os"
)

func readCredential(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, FeedMaxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > FeedMaxBytes {
		return nil, errors.New("credential exceeds 1 MiB")
	}
	return data, nil
}
