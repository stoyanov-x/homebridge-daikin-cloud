# Development Scripts

Utility scripts for working with the Homebridge Daikin Cloud plugin.

## Available Scripts

### 🔧 `dev.sh`
Interactive development menu with common tasks.

```bash
./scripts/dev.sh
```

Provides quick access to:
- Run CI checks locally
- Build plugin
- Deploy plugin to remote server
- Clean build artifacts

---

### ✅ `ci-local.sh`
Run all CI checks locally before pushing.

```bash
./scripts/ci-local.sh
```

Mirrors GitHub Actions workflows to catch issues early:
- Install dependencies
- Run ESLint
- TypeScript type checking
- Build verification

---

### 🏠 `deploy.sh`
Deploy the Homebridge plugin to remote server.

```bash
./scripts/deploy.sh
```

Environment variables:
- `REMOTE_HOST` - Remote server hostname **(required)**
- `REMOTE_USER` - SSH user **(required)**
- `REMOTE_PLUGIN_DIR` - Plugin directory on remote **(required)**
- `CONTAINER_MOUNT_PATH` - Mount path inside container (default: /homebridge/custom)

> Create a `.env` file in the `scripts/` directory to set these permanently
> (see `.env.example`). `.env` is gitignored so your personal settings stay local.
- `PLUGIN_PATTERN` - Plugin file pattern (default: homebridge-*.tgz)
- `CONTAINER_PATTERN` - Container name pattern (default: homebridge-homebridge-)

Example with custom settings:
```bash
REMOTE_HOST=myserver.local ./scripts/deploy.sh
```

---

## Quick Start

```bash
# Interactive menu (recommended for new users)
./scripts/dev.sh

# Or run specific tasks directly
./scripts/ci-local.sh    # Run all checks
./scripts/deploy.sh      # Deploy plugin
```

---

## CI/CD Integration

The `ci-local.sh` script mirrors the GitHub Actions workflow in `.github/workflows/ci.yml`. Running it locally before pushing ensures your changes will pass CI.
