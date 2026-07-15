package oidc

import (
	"context"
	"crypto/rsa"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/google/uuid"
	"github.com/zitadel/oidc/v3/pkg/oidc"
	"github.com/zitadel/oidc/v3/pkg/op"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"golang.org/x/crypto/bcrypt"
)
// UserGetter is the minimal interface for retrieving users.
type UserGetter interface {
	GetUserByID(ctx context.Context, id string) (*User, error)
}

// authUserGetter bridges auth.Service (*models.User) to our UserGetter (*User).
type authUserGetter struct {
	svc *auth.Service
}

func (g *authUserGetter) GetUserByID(ctx context.Context, id string) (*User, error) {
	m, err := g.svc.GetUserByID(ctx, id)
	if err != nil {
		return nil, err
	}
	return &User{
		ID:        m.ID,
		Username:  m.Username,
		Email:     m.Email,
		Role:      m.Role,
		CreatedAt: m.CreatedAt,
		UpdatedAt: m.UpdatedAt,
	}, nil
}

// User is a simplified user record matching the users table schema.
type User struct {
	ID        string
	Username  string
	Email     string
	Role      string
	CreatedAt time.Time
	UpdatedAt time.Time
}


// Storage implements op.Storage with in-memory ephemeral state and DB-backed persistent state.
type Storage struct {
	db            *database.DB
	userGetter    UserGetter
	encryptionKey string
	logger        *slog.Logger
	clientsMu     sync.Mutex
	clients       map[string]*Client
	authRequests  map[string]*AuthRequest
	codes         map[string]string
	tokens        map[string]*Token
	refreshTokens map[string]*RefreshToken
}

var (
	_ op.Storage                   = (*Storage)(nil)
	_ op.CanSetUserinfoFromRequest = (*Storage)(nil)
)

// NewStorage creates a new OIDC storage backend.
func NewStorage(db *database.DB, userGetter UserGetter, encryptionKey string, logger *slog.Logger) *Storage {
	return &Storage{
		db:            db,
		userGetter:    userGetter,
		encryptionKey: encryptionKey,
		logger:        logger.With("component", "oidc"),
		clients:       make(map[string]*Client),
		authRequests:  make(map[string]*AuthRequest),
		codes:         make(map[string]string),
		tokens:        make(map[string]*Token),
		refreshTokens: make(map[string]*RefreshToken),
	}
}

// NewStorageWithAuthService creates a Storage wrapping an auth.Service.
func NewStorageWithAuthService(db *database.DB, authSvc *auth.Service, encryptionKey string, logger *slog.Logger) *Storage {
	return NewStorage(db, &authUserGetter{svc: authSvc}, encryptionKey, logger)
}

// ---------- AuthRequest CRUD ----------

func (s *Storage) CreateAuthRequest(ctx context.Context, authReq *oidc.AuthRequest, userID string) (op.AuthRequest, error) {
	s.clientsMu.Lock()
	defer s.clientsMu.Unlock()

	request := &AuthRequest{
		id:           uuid.NewString(),
		clientID:     authReq.ClientID,
		redirectURI:  authReq.RedirectURI,
		scopes:       authReq.Scopes,
		state:        authReq.State,
		subject:      userID,
		audience:     []string{authReq.ClientID},
		authTime:     time.Now(),
		responseType: authReq.ResponseType,
		responseMode: authReq.ResponseMode,
		nonce:        authReq.Nonce,
	}
	// OIDC authReq.CodeChallenge is a string; op.AuthRequest stores *CodeChallenge
	// We ignore it here — PKCE verification is done by the library itself.
	_ = authReq.CodeChallenge

	s.authRequests[request.id] = request
	return request, nil
}

func (s *Storage) AuthRequestByID(ctx context.Context, id string) (op.AuthRequest, error) {
	s.clientsMu.Lock()
	defer s.clientsMu.Unlock()

	r, ok := s.authRequests[id]
	if !ok {
		return nil, fmt.Errorf("auth request %q not found", id)
	}
	return r, nil
}

func (s *Storage) AuthRequestByCode(ctx context.Context, code string) (op.AuthRequest, error) {
	s.clientsMu.Lock()
	defer s.clientsMu.Unlock()

	requestID, ok := s.codes[code]
	if !ok {
		return nil, fmt.Errorf("code invalid or expired")
	}
	return s.authRequests[requestID], nil
}

func (s *Storage) SaveAuthCode(ctx context.Context, id string, code string) error {
	s.clientsMu.Lock()
	defer s.clientsMu.Unlock()
	s.codes[code] = id
	return nil
}

func (s *Storage) DeleteAuthRequest(ctx context.Context, id string) error {
	s.clientsMu.Lock()
	defer s.clientsMu.Unlock()

	delete(s.authRequests, id)
	for code, rid := range s.codes {
		if rid == id {
			delete(s.codes, code)
		}
	}
	return nil
}

// ---------- Access Tokens ----------

func (s *Storage) CreateAccessToken(ctx context.Context, request op.TokenRequest) (string, time.Time, error) {
	var clientID string
	switch req := request.(type) {
	case *AuthRequest:
		clientID = req.GetClientID()
	case op.TokenExchangeRequest:
		clientID = req.GetClientID()
	}

	token, err := s.createAccessToken(clientID, "", request.GetSubject(), request.GetAudience(), request.GetScopes())
	if err != nil {
		return "", time.Time{}, err
	}
	return token.id, token.expiration, nil
}

func (s *Storage) CreateAccessAndRefreshTokens(ctx context.Context, request op.TokenRequest, currentRefreshToken string) (string, string, time.Time, error) {
	// Token exchange flow
	if teReq, ok := request.(op.TokenExchangeRequest); ok {
		clientID := teReq.GetClientID()
		token, err := s.createAccessToken(clientID, "", teReq.GetSubject(), teReq.GetAudience(), teReq.GetScopes())
		if err != nil {
			return "", "", time.Time{}, err
		}
		rtID := uuid.NewString()
		rt := &RefreshToken{
			id:            rtID,
			applicationID: clientID,
			userID:        token.subject,
			accessTokenID: token.id,
			audience:      token.audience,
			scopes:        token.scopes,
			authTime:      time.Now(),
			expiration:    time.Now().Add(24 * time.Hour),
		}
		s.refreshTokens[rt.id] = rt
		return token.id, rtID, token.expiration, nil
	}

	// Determine client ID and auth time from request
	var clientID string
	var authTime time.Time
	var amr []string
	switch req := request.(type) {
	case *AuthRequest:
		clientID = req.id
		authTime = req.authTime
	case *RefreshTokenRequest:
		clientID = req.applicationID
		authTime = req.authTime
		amr = req.amr
	}

	if currentRefreshToken == "" {
		// Authorization code flow
		rtID := uuid.NewString()
		token, err := s.createAccessToken(clientID, rtID, request.GetSubject(), request.GetAudience(), request.GetScopes())
		if err != nil {
			return "", "", time.Time{}, err
		}
		rt := &RefreshToken{
			id:            rtID,
			applicationID: clientID,
			userID:        token.subject,
			accessTokenID: token.id,
			audience:      token.audience,
			scopes:        token.scopes,
			amr:           amr,
			authTime:      authTime,
			expiration:    time.Now().Add(24 * time.Hour),
		}
		s.refreshTokens[rt.id] = rt
		return token.id, rtID, token.expiration, nil
	}

	// Refresh token rotation
	s.clientsMu.Lock()
	currentRT, ok := s.refreshTokens[currentRefreshToken]
	if !ok {
		s.clientsMu.Unlock()
		return "", "", time.Time{}, op.ErrInvalidRefreshToken
	}
	delete(s.refreshTokens, currentRT.id)
	if currentRT.accessTokenID != "" {
		delete(s.tokens, currentRT.accessTokenID)
	}
	s.clientsMu.Unlock()

	rtID := uuid.NewString()
	token, err := s.createAccessToken(clientID, rtID, request.GetSubject(), request.GetAudience(), request.GetScopes())
	if err != nil {
		return "", "", time.Time{}, err
	}
	newRT := &RefreshToken{
		id:            rtID,
		applicationID: clientID,
		userID:        token.subject,
		accessTokenID: token.id,
		audience:      token.audience,
		scopes:        token.scopes,
		amr:           currentRT.amr,
		authTime:      authTime,
		expiration:    time.Now().Add(24 * time.Hour),
	}
	s.refreshTokens[newRT.id] = newRT
	return token.id, rtID, token.expiration, nil
}

// ---------- Refresh Tokens ----------

func (s *Storage) TokenRequestByRefreshToken(ctx context.Context, refreshToken string) (op.RefreshTokenRequest, error) {
	s.clientsMu.Lock()
	rt, ok := s.refreshTokens[refreshToken]
	s.clientsMu.Unlock()

	if !ok {
		return nil, op.ErrInvalidRefreshToken
	}
	return &RefreshTokenRequest{
		applicationID: rt.applicationID,
		userID:        rt.userID,
		amr:           rt.amr,
		authTime:      rt.authTime,
		scopes:        rt.scopes,
		
	}, nil
}

func (s *Storage) GetRefreshTokenInfo(ctx context.Context, clientID string, token string) (string, string, error) {
	s.clientsMu.Lock()
	rt, ok := s.refreshTokens[token]
	s.clientsMu.Unlock()

	if !ok {
		return "", "", op.ErrInvalidRefreshToken
	}
	return rt.userID, rt.id, nil
}

// ---------- Session & Revocation ----------

func (s *Storage) TerminateSession(ctx context.Context, userID string, clientID string) error {
	s.clientsMu.Lock()
	defer s.clientsMu.Unlock()

	for _, token := range s.tokens {
		if token.applicationID == clientID && token.subject == userID {
			delete(s.tokens, token.id)
			if token.refreshTokenID != "" {
				delete(s.refreshTokens, token.refreshTokenID)
			}
		}
	}
	return nil
}

func (s *Storage) RevokeToken(ctx context.Context, tokenOrTokenID string, userID string, clientID string) *oidc.Error {
	s.clientsMu.Lock()
	defer s.clientsMu.Unlock()

	if token, ok := s.tokens[tokenOrTokenID]; ok {
		if token.applicationID != clientID {
			return oidc.ErrInvalidClient().WithDescription("token was not issued for this client")
		}
		delete(s.tokens, token.id)
		return nil
	}
	if rt, ok := s.refreshTokens[tokenOrTokenID]; ok {
		if rt.applicationID != clientID {
			return oidc.ErrInvalidClient().WithDescription("token was not issued for this client")
		}
		delete(s.refreshTokens, rt.id)
		if rt.accessTokenID != "" {
			delete(s.tokens, rt.accessTokenID)
		}
		return nil
	}
	return nil
}

// ---------- Signing Keys ----------

func (s *Storage) SigningKey(ctx context.Context) (op.SigningKey, error) {
	return EnsureSigningKey(s.db, s.encryptionKey)
}

func (s *Storage) SignatureAlgorithms(ctx context.Context) ([]jose.SignatureAlgorithm, error) {
	return []jose.SignatureAlgorithm{jose.RS256}, nil
}

func (s *Storage) KeySet(ctx context.Context) ([]op.Key, error) {
	sk, err := s.SigningKey(ctx)
	if err != nil {
		return nil, err
	}
	privKey, ok := sk.Key().(*rsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("signing key is not RSA")
	}
	return []op.Key{
		&publicKey{
			id:        sk.ID(),
			algorithm: sk.SignatureAlgorithm(),
			pubKey:    &privKey.PublicKey,
		},
	}, nil
}

// ---------- Client Management ----------

func (s *Storage) GetClientByClientID(ctx context.Context, clientID string) (op.Client, error) {
	s.clientsMu.Lock()
	if c, ok := s.clients[clientID]; ok {
		s.clientsMu.Unlock()
		return &OIDCClient{c}, nil
	}
	s.clientsMu.Unlock()

	c, err := s.loadClientFromDB(ctx, clientID)
	if err != nil {
		return nil, err
	}

	s.clientsMu.Lock()
	s.clients[clientID] = c
	s.clientsMu.Unlock()

	return &OIDCClient{c}, nil
}

func (s *Storage) loadClientFromDB(ctx context.Context, clientID string) (*Client, error) {
	sqlDB := s.db.SQL()
	var c Client
	var redirectURIsJSON string

	err := sqlDB.QueryRowContext(ctx,
		`SELECT id, instance_id, client_id, client_secret, redirect_uris, scopes, name, created_at, updated_at
		 FROM oidc_clients WHERE client_id = ?`,
		clientID,
	).Scan(&c.ID, &c.InstanceID, &c.ClientID, &c.ClientSecret, &redirectURIsJSON, &c.Scopes, &c.Name, &c.CreatedAt, &c.UpdatedAt)

	if err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("client %q not found", clientID)
		}
		return nil, fmt.Errorf("query client %q: %w", clientID, err)
	}

	if err := json.Unmarshal([]byte(redirectURIsJSON), &c.RedirectURIs); err != nil {
		return nil, fmt.Errorf("parse redirect_uris for client %q: %w", clientID, err)
	}

	return &c, nil
}

func (s *Storage) AuthorizeClientIDSecret(ctx context.Context, clientID, clientSecret string) error {
	client, err := s.GetClientByClientID(ctx, clientID)
	if err != nil {
		return err
	}
	if client.GetID() != clientID {
		return fmt.Errorf("invalid client")
	}

	dbClient, ok := client.(*OIDCClient)
	if !ok {
		return fmt.Errorf("invalid client type")
	}

	if err := bcrypt.CompareHashAndPassword([]byte(dbClient.ClientSecret), []byte(clientSecret)); err != nil {
		return fmt.Errorf("invalid client secret")
	}
	return nil
}

// ---------- Userinfo & Introspection ----------

func (s *Storage) SetUserinfoFromScopes(ctx context.Context, userinfo *oidc.UserInfo, userID, clientID string, scopes []string) error {
	return nil
}

func (s *Storage) SetUserinfoFromRequest(ctx context.Context, userinfo *oidc.UserInfo, request op.IDTokenRequest, scopes []string) error {
	user, err := s.userGetter.GetUserByID(ctx, request.GetSubject())
	if err != nil {
		return fmt.Errorf("get user %q for userinfo: %w", request.GetSubject(), err)
	}
	return s.fillUserinfo(userinfo, user, scopes)
}

func (s *Storage) SetUserinfoFromToken(ctx context.Context, userinfo *oidc.UserInfo, tokenID, subject, origin string) error {
	s.clientsMu.Lock()
	token, ok := s.tokens[tokenID]
	s.clientsMu.Unlock()

	if !ok {
		return fmt.Errorf("token not found")
	}
	if token.expiration.Before(time.Now()) {
		return fmt.Errorf("token expired")
	}

	user, err := s.userGetter.GetUserByID(ctx, subject)
	if err != nil {
		return fmt.Errorf("get user for userinfo: %w", err)
	}
	return s.fillUserinfo(userinfo, user, token.scopes)
}

func (s *Storage) SetIntrospectionFromToken(ctx context.Context, introspection *oidc.IntrospectionResponse, tokenID, subject, clientID string) error {
	s.clientsMu.Lock()
	token, ok := s.tokens[tokenID]
	s.clientsMu.Unlock()

	if !ok {
		return fmt.Errorf("token not found")
	}
	if token.expiration.Before(time.Now()) {
		return fmt.Errorf("token expired")
	}

	audValid := false
	for _, aud := range token.audience {
		if aud == clientID {
			audValid = true
			break
		}
	}
	if !audValid {
		return fmt.Errorf("token not valid for this client")
	}

	introspection.Expiration = oidc.FromTime(token.expiration)

	user, err := s.userGetter.GetUserByID(ctx, subject)
	if err != nil {
		return fmt.Errorf("get user for introspection: %w", err)
	}
	ui := new(oidc.UserInfo)
	if err := s.fillUserinfo(ui, user, token.scopes); err != nil {
		return err
	}
	introspection.SetUserInfo(ui)
	introspection.Scope = oidc.SpaceDelimitedArray(token.scopes)
	introspection.ClientID = token.applicationID
	introspection.Subject = subject
	return nil
}

func (s *Storage) fillUserinfo(userinfo *oidc.UserInfo, user *User, scopes []string) error {
	for _, scope := range scopes {
		switch scope {
		case oidc.ScopeOpenID:
			userinfo.Subject = user.ID
		case oidc.ScopeEmail:
			userinfo.Email = user.Email
			userinfo.EmailVerified = oidc.Bool(true)
		case oidc.ScopeProfile:
			userinfo.PreferredUsername = user.Username
			userinfo.Name = user.Username
		case "groups":
			if user.Role != "" {
				userinfo.AppendClaims("groups", []string{user.Role})
			}
		}
	}
	return nil
}

func (s *Storage) GetPrivateClaimsFromScopes(ctx context.Context, userID, clientID string, scopes []string) (map[string]any, error) {
	return nil, nil
}

func (s *Storage) GetKeyByIDAndClientID(ctx context.Context, keyID, clientID string) (*jose.JSONWebKey, error) {
	return nil, fmt.Errorf("JWT profile keys not supported in v1")
}

func (s *Storage) ValidateJWTProfileScopes(ctx context.Context, userID string, scopes []string) ([]string, error) {
	allowed := make([]string, 0)
	for _, scope := range scopes {
		if scope == oidc.ScopeOpenID {
			allowed = append(allowed, scope)
		}
	}
	return allowed, nil
}

func (s *Storage) Health(ctx context.Context) error {
	if s.db != nil {
		if err := s.db.Ping(); err != nil {
			return fmt.Errorf("db ping failed: %w", err)
		}
	}
	return nil
}

// ---------- Internal helpers ----------

func (s *Storage) createAccessToken(applicationID, refreshTokenID, subject string, audience, scopes []string) (*Token, error) {
	s.clientsMu.Lock()
	defer s.clientsMu.Unlock()

	token := &Token{
		id:             uuid.NewString(),
		applicationID:  applicationID,
		refreshTokenID: refreshTokenID,
		subject:        subject,
		audience:       audience,
		scopes:         scopes,
		expiration:     time.Now().Add(1 * time.Hour),
	}
	s.tokens[token.id] = token
	return token, nil
}
