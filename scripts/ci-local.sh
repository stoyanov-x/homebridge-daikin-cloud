#!/bin/bash

# Local CI Script - Run all checks before pushing
# This mirrors the GitHub Actions workflows to catch issues early

set -e  # Exit on any error

# Get repo root (parent of scripts/ directory)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Track results
CHECKS_PASSED=0
CHECKS_FAILED=0

print_header() {
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}  🚀 Running Local CI Checks${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

print_summary() {
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}  📊 Summary${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "  ${GREEN}Passed: $CHECKS_PASSED${NC}"
    echo -e "  ${RED}Failed: $CHECKS_FAILED${NC}"
    echo ""

    if [ $CHECKS_FAILED -eq 0 ]; then
        echo -e "${GREEN}✓ All checks passed! Ready to push.${NC}"
        echo ""
        exit 0
    else
        echo -e "${RED}✗ Some checks failed. Fix issues before pushing.${NC}"
        echo ""
        exit 1
    fi
}

print_header

# ===========================================================================
# CHECK: npm installed
# ===========================================================================

if ! command -v npm &> /dev/null; then
    echo -e "${RED}✗ npm not found${NC}"
    echo "  Install Node.js from https://nodejs.org"
    exit 1
fi

# ===========================================================================
# CHECK: Install dependencies
# ===========================================================================

echo -e "${YELLOW}→ Installing dependencies...${NC}"
npm ci > /dev/null 2>&1 || npm install > /dev/null || {
    echo -e "${RED}✗ Dependencies install failed${NC}"
    ((CHECKS_FAILED++))
    print_summary
}
echo -e "${GREEN}✓ Dependencies installed${NC}"
((CHECKS_PASSED++))

# ===========================================================================
# CHECK: Linting
# ===========================================================================

echo -e "${YELLOW}→ Running linter...${NC}"
if npm run lint > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Linter passed${NC}"
    ((CHECKS_PASSED++))
else
    echo -e "${RED}✗ Linter failed${NC}"
    echo ""
    npm run lint  # Show the errors
    ((CHECKS_FAILED++))
    print_summary
fi

# ===========================================================================
# CHECK: TypeScript type check
# ===========================================================================

echo -e "${YELLOW}→ Running TypeScript type check...${NC}"
if ./node_modules/.bin/tsc --noEmit > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Type check passed${NC}"
    ((CHECKS_PASSED++))
else
    echo -e "${RED}✗ Type check failed${NC}"
    echo ""
    ./node_modules/.bin/tsc --noEmit  # Show the errors
    ((CHECKS_FAILED++))
    print_summary
fi

# ===========================================================================
# CHECK: Build
# ===========================================================================

echo -e "${YELLOW}→ Building project...${NC}"
if npm run build > /dev/null 2>&1; then
    # Verify artifacts — main entry is dist/src/index.js per package.json
    if [ -f "dist/src/index.js" ] && [ -f "dist/src/index.d.ts" ]; then
        echo -e "${GREEN}✓ Build succeeded${NC}"
        ((CHECKS_PASSED++))
    else
        echo -e "${RED}✗ Build artifacts missing${NC}"
        ((CHECKS_FAILED++))
        print_summary
    fi
else
    echo -e "${RED}✗ Build failed${NC}"
    echo ""
    npm run build  # Show the errors
    ((CHECKS_FAILED++))
    print_summary
fi

# ===========================================================================
# SUMMARY
# ===========================================================================

print_summary
