// Package pagination provides utilities for paginated API responses.
package pagination

import (
	"math"
	"net/http"
	"strconv"
)

// Default values for pagination
const (
	DefaultPageSize = 20
	MaxPageSize     = 100
	MinPageSize     = 1
	DefaultPage     = 1
)

// Params represents pagination parameters extracted from a request
type Params struct {
	Page     int `json:"page"`
	PageSize int `json:"page_size"`
	Offset   int `json:"-"`
	Limit    int `json:"-"`
}

// Result represents a paginated result set
type Result struct {
	Data       interface{} `json:"data"`
	Pagination Metadata    `json:"pagination"`
}

// Metadata contains pagination metadata
type Metadata struct {
	Page        int   `json:"page"`
	PageSize    int   `json:"page_size"`
	TotalItems  int64 `json:"total_items"`
	TotalPages  int   `json:"total_pages"`
	HasNextPage bool  `json:"has_next_page"`
	HasPrevPage bool  `json:"has_prev_page"`
	NextPage    int   `json:"next_page,omitempty"`
	PrevPage    int   `json:"prev_page,omitempty"`
}

// FromRequest extracts pagination parameters from an HTTP request
func FromRequest(r *http.Request) Params {
	pageStr := r.URL.Query().Get("page")
	pageSizeStr := r.URL.Query().Get("page_size")

	page := DefaultPage
	if p, err := strconv.Atoi(pageStr); err == nil && p > 0 {
		page = p
	}

	pageSize := DefaultPageSize
	if ps, err := strconv.Atoi(pageSizeStr); err == nil {
		if ps < MinPageSize {
			pageSize = MinPageSize
		} else if ps > MaxPageSize {
			pageSize = MaxPageSize
		} else {
			pageSize = ps
		}
	}

	offset := (page - 1) * pageSize
	if offset < 0 {
		offset = 0
	}

	return Params{
		Page:     page,
		PageSize: pageSize,
		Offset:   offset,
		Limit:    pageSize,
	}
}

// CalculateMetadata calculates pagination metadata from total count
func CalculateMetadata(totalItems int64, params Params) Metadata {
	totalPages := int(math.Ceil(float64(totalItems) / float64(params.PageSize)))
	if totalPages < 1 {
		totalPages = 1
	}

	hasNextPage := params.Page < totalPages
	hasPrevPage := params.Page > 1

	metadata := Metadata{
		Page:        params.Page,
		PageSize:    params.PageSize,
		TotalItems:  totalItems,
		TotalPages:  totalPages,
		HasNextPage: hasNextPage,
		HasPrevPage: hasPrevPage,
	}

	if hasNextPage {
		metadata.NextPage = params.Page + 1
	}
	if hasPrevPage {
		metadata.PrevPage = params.Page - 1
	}

	return metadata
}

// NewResult creates a new paginated result
func NewResult(data interface{}, totalItems int64, params Params) Result {
	return Result{
		Data:       data,
		Pagination: CalculateMetadata(totalItems, params),
	}
}

// ValidateParams validates and normalizes pagination parameters
func ValidateParams(page, pageSize int) Params {
	if page < 1 {
		page = DefaultPage
	}
	if pageSize < MinPageSize {
		pageSize = MinPageSize
	} else if pageSize > MaxPageSize {
		pageSize = MaxPageSize
	}

	return Params{
		Page:     page,
		PageSize: pageSize,
		Offset:   (page - 1) * pageSize,
		Limit:    pageSize,
	}
}
