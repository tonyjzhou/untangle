# Planner Development Makefile
# Flask + vanilla JS idea-to-plan app

DEV_PORT ?= 5001
VENV := .venv
PYTHON := $(VENV)/bin/python
PIP := $(VENV)/bin/pip

.PHONY: dev stop clean-port status help setup

# Default target
help:
	@echo "Planner Development Commands"
	@echo "============================"
	@echo ""
	@echo "Setup:"
	@echo "  make setup            - Create venv + install dependencies"
	@echo ""
	@echo "Local Development:"
	@echo "  make dev              - Setup (if needed) + start server (port $(DEV_PORT))"
	@echo "  make stop             - Stop dev server"
	@echo "  make status           - Show running dev servers"

# ============================================
# Setup
# ============================================

setup:
	@if [ ! -d "$(VENV)" ]; then \
		echo "Creating virtualenv..."; \
		python3 -m venv $(VENV); \
	fi
	@echo "Installing dependencies..."
	@$(PIP) install -q -r requirements.txt
	@echo "Dependencies installed."

# ============================================
# Local Development
# ============================================

dev: clean-port
	@if [ ! -d "$(VENV)" ] || [ ! -x "$(PYTHON)" ]; then \
		$(MAKE) setup; \
	else \
		$(PIP) install -q -r requirements.txt; \
	fi
	@echo "Starting planner on port $(DEV_PORT)..."
	@set -a; [ -f .env ] && . ./.env; set +a; \
	PORT=$(DEV_PORT) $(PYTHON) app.py

clean-port:
	@echo "Cleaning up port $(DEV_PORT)..."
	@-lsof -ti:$(DEV_PORT) | xargs kill -9 2>/dev/null || true
	@sleep 0.5

stop:
	@echo "Stopping dev servers..."
	@-lsof -ti:$(DEV_PORT) | xargs kill -9 2>/dev/null || true
	@echo "Dev servers stopped."

status:
	@echo "=== Dev Server (port $(DEV_PORT)) ==="
	@lsof -i:$(DEV_PORT) 2>/dev/null || echo "Nothing running"
