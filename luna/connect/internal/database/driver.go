package database

import (
	"strconv"
	"strings"
)

// Driver names supported database backends.
type Driver string

const (
	DriverSQLite   Driver = "sqlite"
	DriverPostgres Driver = "postgres"
)

func rebind(driver Driver, query string) string {
	if driver != DriverPostgres {
		return query
	}
	var b strings.Builder
	b.Grow(len(query) + 8)
	n := 1
	for i := 0; i < len(query); i++ {
		if query[i] == '?' {
			b.WriteByte('$')
			b.WriteString(strconv.Itoa(n))
			n++
		} else {
			b.WriteByte(query[i])
		}
	}
	return b.String()
}
