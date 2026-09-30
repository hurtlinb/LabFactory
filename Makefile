REGISTRY := hurtlinb/labfactory
VERSION  := $(shell node -p "require('./package.json').version" 2>/dev/null || echo latest)

.PHONY: all build push login \
        build-dashboard build-api build-worker build-custom-tasks \
        push-dashboard  push-api  push-worker push-custom-tasks

all: build push

login:
	docker login

# ── Build ────────────────────────────────────────────────────────────────────

build: build-dashboard build-api build-worker build-custom-tasks

build-dashboard:
	docker build -f docker/dashboard/Dockerfile \
	  -t $(REGISTRY):dashboard \
	  -t $(REGISTRY):dashboard-$(VERSION) .

build-api:
	docker build -f docker/api/Dockerfile \
	  -t $(REGISTRY):api \
	  -t $(REGISTRY):api-$(VERSION) .

# Image combinée Terraform + Ansible (workers k8s)
build-worker:
	docker build -f Dockerfile \
	  -t $(REGISTRY):worker \
	  -t $(REGISTRY):worker-$(VERSION) .

build-custom-tasks:
	docker build -f docker/custom-tasks/Dockerfile \
	  -t $(REGISTRY):custom-tasks \
	  -t $(REGISTRY):custom-tasks-$(VERSION) .

# ── Push ─────────────────────────────────────────────────────────────────────

push: push-dashboard push-api push-worker push-custom-tasks

push-dashboard:
	docker push $(REGISTRY):dashboard
	docker push $(REGISTRY):dashboard-$(VERSION)

push-api:
	docker push $(REGISTRY):api
	docker push $(REGISTRY):api-$(VERSION)

push-worker:
	docker push $(REGISTRY):worker
	docker push $(REGISTRY):worker-$(VERSION)

push-custom-tasks:
	docker push $(REGISTRY):custom-tasks
	docker push $(REGISTRY):custom-tasks-$(VERSION)
