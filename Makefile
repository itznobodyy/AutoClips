.DEFAULT_GOAL := help

HOST ?=
APP_DIR ?= /opt/autoclips
COOKIE_FILE ?= secrets/cookies.txt
SERVICE ?=

.PHONY: help check-host deploy logs restart cookies

help:
	@printf "Targets:\n  deploy   Pull latest code and reload AutoClips\n  logs     Follow Docker Compose logs (optional: SERVICE=pot)\n  restart  Restart the AutoClips systemd service\n  cookies  Upload COOKIE_FILE securely and restart AutoClips\n\nSet HOST, for example: make deploy HOST=root@your-server\n"

check-host:
	@test -n "$(HOST)" || { echo "Indica el servidor: make <target> HOST=root@tu-servidor" >&2; exit 2; }

deploy: check-host
	ssh "$(HOST)" "cd '$(APP_DIR)' && git pull --ff-only && systemctl reload autoclips"

logs: check-host
	ssh "$(HOST)" "cd '$(APP_DIR)' && docker compose logs -f --tail=100 $(SERVICE)"

restart: check-host
	ssh "$(HOST)" "systemctl restart autoclips"

cookies: check-host
	@test -f "$(COOKIE_FILE)" || { echo "No existe COOKIE_FILE: $(COOKIE_FILE)" >&2; exit 2; }
	ssh "$(HOST)" "umask 077 && cat > '$(APP_DIR)/secrets/cookies.txt.tmp' && mv '$(APP_DIR)/secrets/cookies.txt.tmp' '$(APP_DIR)/secrets/cookies.txt' && systemctl restart autoclips" < "$(COOKIE_FILE)"
