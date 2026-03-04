# Printing Press Manager API

A complete backend server for managing a kiosk-based automated printing system with:
- 🖨️ **Kiosk Management** - Register, monitor, track ink/paper levels
- 📄 **Document Handling** - Upload metadata, page counting, checksums
- 💰 **Pricing & Payments** - Auto-calculate costs, generate payment links
- 📡 **Real-time WebSocket** - Instant job notifications to kiosks
- 🔐 **JWT Authentication** - Secure API access with refresh tokens
- 🐘 **PostgreSQL** - Persistent, transactional data storage

## Quick Start

### 1. Start PostgreSQL
```bash
docker-compose up -d
```

### 2. Install & Run
```bash
npm install
npm start
```

### 3. Access
- **API**: http://localhost:8080
- **Swagger Docs**: http://localhost:8080/docs
- **WebSocket**: ws://localhost:8080/ws
- **Demo credentials**: `admin` / `demo123`

## Architecture

```
┌──────────────┐    QR Scan    ┌──────────────┐
│    User      │──────────────▶│   WhatsApp   │
│  (Customer)  │               │   Chatbot    │
└──────────────┘               └──────┬───────┘
                                      │
                    POST /documents   │  POST /jobs
                    POST /payments    │
                                      ▼
┌──────────────┐               ┌──────────────┐
│    Kiosk     │◀─────────────▶│    Server    │
│  (Printer)   │   WebSocket   │   (Node.js)  │
└──────────────┘   REST API    └──────┬───────┘
                                      │
                                      ▼
                               ┌──────────────┐
                               │  PostgreSQL  │
                               └──────────────┘
```

## API Endpoints

### Authentication
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/auth/login` | Login with username/password |
| POST | `/auth/refresh` | Refresh access token |
| POST | `/auth/logout` | Revoke refresh token |
| POST | `/auth/register` | Create new user |

### Kiosks
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/kiosks` | Register new kiosk |
| GET | `/kiosks` | List user's kiosks |
| GET | `/kiosks/:id` | Get kiosk details |
| GET | `/kiosks/:id/status` | Get status, ink, paper (public) |
| POST | `/kiosks/:id/heartbeat` | Send consumable levels |
| POST | `/kiosks/:id/ping` | Request status update via WebSocket |

### Documents
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/documents` | Upload document metadata |
| GET | `/documents/:id` | Get document info |

### Jobs
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/jobs` | Create print job, get pricing |
| GET | `/jobs` | List jobs (filter by kiosk/status) |
| GET | `/jobs/:id` | Get job details |
| POST | `/jobs/:id/claim` | Kiosk claims job (idempotent) |
| POST | `/jobs/:id/complete` | Report success/failure |

### Payments
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/payments` | Generate payment link |
| GET | `/payments/:id` | Get payment status |
| POST | `/payments/:id/webhook` | Payment gateway callback |

## WebSocket Protocol

Connect to `ws://localhost:8080/ws`

### Messages from Client

```json
// 1. Authenticate first
{"type": "auth", "token": "<JWT access token>"}

// 2. Subscribe to kiosk
{"type": "subscribe", "kioskId": "kiosk_xxx"}

// 3. Heartbeat (every 25s)
{"type": "heartbeat"}
```

### Messages from Server

```json
// Authentication result
{"type": "auth_success", "userId": "u_demo"}
{"type": "auth_error", "message": "Invalid token"}

// Subscription confirmed
{"type": "subscribed", "kioskId": "kiosk_xxx"}

// New job ready to print (after payment success)
{
  "type": "job_ready",
  "jobId": "job_xxx",
  "documentId": "doc_xxx",
  "copies": 2,
  "colorMode": "bw",
  "total": 47.2,
  "timestamp": "2026-03-04T12:00:00.000Z"
}

// Server requests status update
{"type": "status_request", "timestamp": "..."}

// Job cancelled
{"type": "job_cancelled", "jobId": "job_xxx", "reason": "User requested"}
```

### Test WebSocket Client

```bash
# Get token first
TOKEN=$(curl -s -X POST http://localhost:8080/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"demo123"}' | jq -r '.accessToken')

# Run WebSocket client
node examples/ws-client.js $TOKEN kiosk_xxx
```

## Print Flow

1. **User scans QR** on kiosk → Opens WhatsApp chatbot
2. **Chatbot** sends `kioskId` and document to server via:
   - `POST /documents` (file URL, page count)
   - `POST /jobs` (copies, color mode) → Returns pricing options
3. **User** selects options → `POST /payments` → Payment link sent
4. **User pays** → Webhook calls `POST /payments/:id/webhook`
5. **Server** marks job `ready_to_print`, notifies kiosk via WebSocket
6. **Kiosk** claims job (`POST /jobs/:id/claim`), downloads document
7. **Kiosk** prints, reports completion (`POST /jobs/:id/complete`)

## Configuration

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8080 | Server port |
| `JWT_SECRET` | - | Secret for JWT signing |
| `ACCESS_TOKEN_TTL` | 15m | Access token expiry |
| `REFRESH_TOKEN_TTL` | 7d | Refresh token expiry |
| `DB_HOST` | localhost | PostgreSQL host |
| `DB_PORT` | 5432 | PostgreSQL port |
| `DB_NAME` | printing_press | Database name |
| `DB_USER` | printing_user | Database user |
| `DB_PASSWORD` | printing_pass | Database password |
| `BW_PER_PAGE` | 2 | B&W price per page (INR) |
| `COLOR_PER_PAGE` | 8 | Color price per page (INR) |
| `GST_PERCENT` | 18 | GST percentage |

## Database Schema

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   users     │     │   kiosks    │     │  documents  │
├─────────────┤     ├─────────────┤     ├─────────────┤
│ id          │──┐  │ id          │◀──┐ │ id          │
│ username    │  │  │ owner_id    │───┘ │ kiosk_id    │
│ password    │  │  │ name        │     │ file_url    │
│ role        │  │  │ ink_*       │     │ page_count  │
└─────────────┘  │  │ paper_count │     │ checksum    │
                 │  └─────────────┘     └──────┬──────┘
┌─────────────┐  │                             │
│refresh_token│  │  ┌─────────────┐     ┌──────▼──────┐
├─────────────┤  │  │  payments   │     │    jobs     │
│ user_id     │──┘  ├─────────────┤     ├─────────────┤
│ token       │     │ id          │◀────│ payment_id  │
│ expires_at  │     │ job_id      │────▶│ document_id │
└─────────────┘     │ amount      │     │ status      │
                    │ status      │     │ claimed_by  │
                    └─────────────┘     └─────────────┘
```

## Project Structure

```
├── docker-compose.yml    # PostgreSQL container
├── openapi.yaml          # OpenAPI 3.0 spec
├── package.json
├── .env                  # Environment config
├── examples/
│   └── ws-client.js      # WebSocket test client
└── src/
    ├── index.js          # Express app + WebSocket
    ├── config.js         # Configuration
    ├── db/
    │   ├── index.js      # PostgreSQL connection
    │   └── init.sql      # Schema
    ├── ws/
    │   └── index.js      # WebSocket server
    ├── middleware/
    │   └── auth.js       # JWT verification
    ├── routes/
    │   ├── auth.js
    │   ├── kiosks.js
    │   ├── documents.js
    │   ├── jobs.js
    │   └── payments.js
    └── utils/
        ├── errors.js
        └── pricing.js
```

## Development

```bash
# Start with file watching
npm run dev

# View logs
docker-compose logs -f postgres

# Reset database
docker-compose down -v
docker-compose up -d
```

## License

ISC
