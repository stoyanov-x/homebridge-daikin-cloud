#!/bin/bash

# Development Quick Start Menu
# Interactive script to help with common development tasks

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Colors
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

show_menu() {
    clear
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}  🔧 Homebridge Daikin Cloud - Development Menu${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo "  1) ✅ Run Local CI Checks"
    echo "  2) 🔨 Build Homebridge Plugin"
    echo "  3) 🏠 Deploy Homebridge Plugin"
    echo "  4) 🧹 Clean Build Artifacts"
    echo ""
    echo "  0) Exit"
    echo ""
    echo -ne "${GREEN}Select option [0-4]:${NC} "
}

while true; do
    show_menu
    read -r choice
    echo ""

    case $choice in
        1)
            echo -e "${YELLOW}Running CI checks...${NC}"
            ./scripts/ci-local.sh
            read -p "Press Enter to continue..."
            ;;
        2)
            echo -e "${YELLOW}Building Homebridge plugin...${NC}"
            npm install && npm run build
            echo -e "${GREEN}✓ Build complete${NC}"
            read -p "Press Enter to continue..."
            ;;
        3)
            echo -e "${YELLOW}Deploying Homebridge plugin...${NC}"
            ./scripts/deploy.sh
            read -p "Press Enter to continue..."
            ;;
        4)
            echo -e "${YELLOW}Cleaning build artifacts...${NC}"
            rm -rf dist/
            rm -f *.tgz
            echo -e "${GREEN}✓ Clean complete${NC}"
            read -p "Press Enter to continue..."
            ;;
        0)
            echo -e "${GREEN}Goodbye!${NC}"
            exit 0
            ;;
        *)
            echo -e "${YELLOW}Invalid option. Press Enter to continue...${NC}"
            read -r
            ;;
    esac
done
