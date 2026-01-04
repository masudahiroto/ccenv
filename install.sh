#!/bin/bash
set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}Installing ccenv...${NC}"

# Check requirements
if ! command -v git &> /dev/null; then
    echo -e "${RED}Error: git is not installed.${NC}"
    exit 1
fi

if ! command -v bun &> /dev/null; then
    echo -e "${RED}Error: bun is not installed. Please install bun first: https://bun.sh${NC}"
    exit 1
fi

# Configuration
REPO_URL="https://github.com/masudahiroto/ccenv.git"
INSTALL_DIR="$HOME/.ccenv"
BRANCH="main"

# Clone or Update
if [ -d "$INSTALL_DIR" ]; then
    echo -e "${BLUE}Updating existing installation at $INSTALL_DIR...${NC}"
    cd "$INSTALL_DIR"
    if [ -d ".git" ]; then
        git pull origin "$BRANCH" || git pull origin master || echo -e "${RED}Warning: Failed to pull latest changes.${NC}"
    else
        echo -e "${RED}Error: $INSTALL_DIR exists but is not a git repository.${NC}"
        exit 1
    fi
else
    echo -e "${BLUE}Cloning into $INSTALL_DIR...${NC}"
    git clone "$REPO_URL" "$INSTALL_DIR"
fi

# Install dependencies
echo -e "${BLUE}Installing dependencies...${NC}"
cd "$INSTALL_DIR"
bun install --production

# Setup Alias
SHELL_NAME=$(basename "$SHELL")
RC_FILE=""

case "$SHELL_NAME" in
    zsh)
        RC_FILE="$HOME/.zshrc"
        ;;
    bash)
        # MacOS default bash uses .bash_profile, Linux uses .bashrc
        if [[ "$OSTYPE" == "darwin"* ]]; then
            RC_FILE="$HOME/.bash_profile"
        else
            RC_FILE="$HOME/.bashrc"
        fi
        ;;
    *)
        echo -e "${RED}Warning: Unsupported shell '$SHELL_NAME'. You might need to add the alias manually.${NC}"
        ;;
esac

ALIAS_CMD="alias ccenv=\"bun run $INSTALL_DIR/src/ccenv.ts\""

if [ -n "$RC_FILE" ]; then
    if [ ! -f "$RC_FILE" ]; then
        touch "$RC_FILE"
    fi

    if grep -q "alias ccenv=" "$RC_FILE"; then
        echo -e "${BLUE}Alias 'ccenv' already exists in $RC_FILE${NC}"
    else
        echo -e "${BLUE}Adding alias to $RC_FILE...${NC}"
        echo "" >> "$RC_FILE"
        echo "# ccenv" >> "$RC_FILE"
        echo "$ALIAS_CMD" >> "$RC_FILE"
        echo -e "${GREEN}Alias added!${NC}"
    fi
fi

echo -e "${GREEN}Installation complete!${NC}"
echo -e "To start using ccenv, restart your terminal or run:"
if [ -n "$RC_FILE" ]; then
    echo -e "${BLUE}  source $RC_FILE${NC}"
else
    echo -e "${BLUE}  $ALIAS_CMD${NC}"
fi
