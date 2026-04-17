package pagination

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFromRequest_DefaultValues(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/users", nil)
	params := FromRequest(req)

	if params.Page != DefaultPage {
		t.Errorf("expected page %d, got %d", DefaultPage, params.Page)
	}
	if params.PageSize != DefaultPageSize {
		t.Errorf("expected page size %d, got %d", DefaultPageSize, params.PageSize)
	}
	if params.Offset != 0 {
		t.Errorf("expected offset 0, got %d", params.Offset)
	}
	if params.Limit != DefaultPageSize {
		t.Errorf("expected limit %d, got %d", DefaultPageSize, params.Limit)
	}
}

func TestFromRequest_CustomPage(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/users?page=5", nil)
	params := FromRequest(req)

	if params.Page != 5 {
		t.Errorf("expected page 5, got %d", params.Page)
	}
	if params.Offset != 80 {
		t.Errorf("expected offset 80, got %d", params.Offset)
	}
}

func TestFromRequest_CustomPageSize(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/users?page_size=50", nil)
	params := FromRequest(req)

	if params.Page != DefaultPage {
		t.Errorf("expected page %d, got %d", DefaultPage, params.Page)
	}
	if params.PageSize != 50 {
		t.Errorf("expected page size 50, got %d", params.PageSize)
	}
	if params.Offset != 0 {
		t.Errorf("expected offset 0, got %d", params.Offset)
	}
}

func TestFromRequest_InvalidPage(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/users?page=-1", nil)
	params := FromRequest(req)

	if params.Page != DefaultPage {
		t.Errorf("expected page %d, got %d", DefaultPage, params.Page)
	}
}

func TestFromRequest_InvalidPageSize(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/users?page_size=150", nil)
	params := FromRequest(req)

	if params.PageSize != MaxPageSize {
		t.Errorf("expected page size %d, got %d", MaxPageSize, params.PageSize)
	}
}

func TestFromRequest_InvalidPageSizeTooSmall(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/users?page_size=0", nil)
	params := FromRequest(req)

	if params.PageSize != MinPageSize {
		t.Errorf("expected page size %d, got %d", MinPageSize, params.PageSize)
	}
}

func TestFromRequest_BothCustom(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/users?page=3&page_size=75", nil)
	params := FromRequest(req)

	if params.Page != 3 {
		t.Errorf("expected page 3, got %d", params.Page)
	}
	if params.PageSize != 75 {
		t.Errorf("expected page size 75, got %d", params.PageSize)
	}
	if params.Offset != 150 {
		t.Errorf("expected offset 150, got %d", params.Offset)
	}
}

func TestCalculateMetadata_SinglePage(t *testing.T) {
	params := Params{Page: 1, PageSize: 20, Limit: 20}
	metadata := CalculateMetadata(15, params)

	if metadata.Page != 1 {
		t.Errorf("expected page 1, got %d", metadata.Page)
	}
	if metadata.PageSize != 20 {
		t.Errorf("expected page size 20, got %d", metadata.PageSize)
	}
	if metadata.TotalItems != 15 {
		t.Errorf("expected total items 15, got %d", metadata.TotalItems)
	}
	if metadata.TotalPages != 1 {
		t.Errorf("expected total pages 1, got %d", metadata.TotalPages)
	}
	if metadata.HasNextPage {
		t.Error("expected no next page for single page")
	}
	if metadata.HasPrevPage {
		t.Error("expected no prev page for first page")
	}
}

func TestCalculateMetadata_MultiplePages(t *testing.T) {
	params := Params{Page: 2, PageSize: 20, Limit: 20}
	metadata := CalculateMetadata(45, params)

	if metadata.Page != 2 {
		t.Errorf("expected page 2, got %d", metadata.Page)
	}
	if metadata.PageSize != 20 {
		t.Errorf("expected page size 20, got %d", metadata.PageSize)
	}
	if metadata.TotalItems != 45 {
		t.Errorf("expected total items 45, got %d", metadata.TotalItems)
	}
	if metadata.TotalPages != 3 {
		t.Errorf("expected total pages 3, got %d", metadata.TotalPages)
	}
	if !metadata.HasNextPage {
		t.Error("expected next page")
	}
	if !metadata.HasPrevPage {
		t.Error("expected prev page")
	}
	if metadata.NextPage != 3 {
		t.Errorf("expected next page 3, got %d", metadata.NextPage)
	}
	if metadata.PrevPage != 1 {
		t.Errorf("expected prev page 1, got %d", metadata.PrevPage)
	}
}

func TestCalculateMetadata_EdgeCase_TotalPagesOne(t *testing.T) {
	params := Params{Page: 1, PageSize: 20, Limit: 20}
	metadata := CalculateMetadata(20, params)

	if metadata.TotalPages != 1 {
		t.Errorf("expected total pages 1, got %d", metadata.TotalPages)
	}
}

func TestCalculateMetadata_ZeroItems(t *testing.T) {
	params := Params{Page: 1, PageSize: 20, Limit: 20}
	metadata := CalculateMetadata(0, params)

	if metadata.TotalPages != 1 {
		t.Errorf("expected total pages 1, got %d", metadata.TotalPages)
	}
	if metadata.HasNextPage {
		t.Error("expected no next page for zero items")
	}
}

func TestNewResult_DataAndMetadata(t *testing.T) {
	data := []map[string]string{
		{"id": "1", "name": "Alice"},
		{"id": "2", "name": "Bob"},
	}
	params := Params{Page: 1, PageSize: 20, Limit: 20}
	result := NewResult(data, 2, params)

	if result.Data == nil {
		t.Fatal("expected data to be set")
	}
	if result.Pagination.Page != 1 {
		t.Errorf("expected pagination page 1, got %d", result.Pagination.Page)
	}
	if result.Pagination.TotalItems != 2 {
		t.Errorf("expected total items 2, got %d", result.Pagination.TotalItems)
	}
}

func TestNewResult_EmptyData(t *testing.T) {
	data := []map[string]string{}
	params := Params{Page: 1, PageSize: 20, Limit: 20}
	result := NewResult(data, 0, params)

	if result.Data == nil {
		t.Fatal("expected data to be set even if empty")
	}
}

func TestValidateParams_WithinRange(t *testing.T) {
	params := ValidateParams(5, 50)

	if params.Page != 5 {
		t.Errorf("expected page 5, got %d", params.Page)
	}
	if params.PageSize != 50 {
		t.Errorf("expected page size 50, got %d", params.PageSize)
	}
}

func TestValidateParams_PageBelowOne_Clamped(t *testing.T) {
	params := ValidateParams(0, 20)

	if params.Page != DefaultPage {
		t.Errorf("expected page %d, got %d", DefaultPage, params.Page)
	}
}

func TestValidateParams_PageBelowZero(t *testing.T) {
	params := ValidateParams(-5, 20)

	if params.Page != DefaultPage {
		t.Errorf("expected page %d, got %d", DefaultPage, params.Page)
	}
}

func TestValidateParams_PageSizeBelowMin_Clamped(t *testing.T) {
	params := ValidateParams(1, 0)

	if params.PageSize != MinPageSize {
		t.Errorf("expected page size %d, got %d", MinPageSize, params.PageSize)
	}
}

func TestValidateParams_PageSizeBelowZero(t *testing.T) {
	params := ValidateParams(1, -10)

	if params.PageSize != MinPageSize {
		t.Errorf("expected page size %d, got %d", MinPageSize, params.PageSize)
	}
}

func TestValidateParams_PageSizeAboveMax_Clamped(t *testing.T) {
	params := ValidateParams(1, 150)

	if params.PageSize != MaxPageSize {
		t.Errorf("expected page size %d, got %d", MaxPageSize, params.PageSize)
	}
}

func TestValidateParams_BothOutOfRange(t *testing.T) {
	params := ValidateParams(0, 150)

	if params.Page != DefaultPage {
		t.Errorf("expected page %d, got %d", DefaultPage, params.Page)
	}
	if params.PageSize != MaxPageSize {
		t.Errorf("expected page size %d, got %d", MaxPageSize, params.PageSize)
	}
}
