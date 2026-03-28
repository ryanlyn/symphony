.PHONY: help all setup deps build fmt fmt-check lint test coverage ci dialyzer e2e

MIX ?= $(shell command -v mix 2>/dev/null || mise which mix 2>/dev/null || printf '%s' mix)
ELIXIR ?= $(shell command -v elixir 2>/dev/null || mise which elixir 2>/dev/null || printf '%s' elixir)
ERL ?= $(shell command -v erl 2>/dev/null || mise which erl 2>/dev/null || printf '%s' erl)
export PATH := $(dir $(MIX)):$(dir $(ELIXIR)):$(dir $(ERL)):$(PATH)

help:
	@echo "Targets: setup, deps, fmt, fmt-check, lint, test, coverage, dialyzer, e2e, ci"

setup:
	$(MIX) setup

deps:
	$(MIX) deps.get

build:
	$(MIX) build

fmt:
	$(MIX) format

fmt-check:
	$(MIX) format --check-formatted

lint:
	$(MIX) lint

coverage:
	$(MIX) test --cover

test:
	$(MIX) test

dialyzer:
	$(MIX) deps.get
	$(MIX) dialyzer --format short

e2e:
	SYMPHONY_RUN_LIVE_E2E=1 $(MIX) test test/symphony_elixir/live_e2e_test.exs

ci:
	$(MAKE) setup
	$(MAKE) build
	$(MAKE) fmt-check
	$(MAKE) lint
	$(MAKE) coverage
	$(MAKE) dialyzer

all: ci
