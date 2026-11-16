job "tunebridge" {
  datacenters = ["dc1"]
  type        = "service"

  variable "image" {
    type    = string
    default = "ghcr.io/YOUR_USER/tunebridge:latest"
  }

  # Secrets: use Nomad Variables (shown) or swap the template for Vault `with secret`.
  # nomad var put nomad/jobs/tunebridge DATABASE_URL=... APP_URL=... TOKEN_ENC_KEYS=... TOKEN_ENC_ACTIVE=1 \
  #   GOOGLE_AUTH_CLIENT_ID=... GOOGLE_AUTH_CLIENT_SECRET=... ALLOWED_EMAILS=... SPOTIFY_CLIENT_ID=...

  group "web" {
    count = 2

    network {
      port "http" { to = 3000 }
    }

    service {
      name     = "tunebridge"
      port     = "http"
      provider = "nomad" # or "consul"
      tags = [
        "traefik.enable=true",
        "traefik.http.routers.tunebridge.rule=Host(`tunebridge.jac-sys.net`)",
        "traefik.http.routers.tunebridge.tls.certresolver=letsencrypt",
      ]
      check {
        type     = "http"
        path     = "/api/health"
        interval = "15s"
        timeout  = "3s"
      }
    }

    # Runs once per allocation before the app; prisma takes a DB advisory lock so replicas don't race.
    task "migrate" {
      lifecycle {
        hook    = "prestart"
        sidecar = false
      }
      driver = "docker"
      config {
        image      = var.image
        entrypoint = ["node", "migrate.js"]
      }
      template {
        data        = "DATABASE_URL={{ with nomadVar \"nomad/jobs/tunebridge\" }}{{ .DATABASE_URL }}{{ end }}"
        destination = "secrets/env"
        env         = true
      }
      resources {
        cpu    = 200
        memory = 256
      }
    }

    task "web" {
      driver = "docker"
      config {
        image = var.image
        ports = ["http"]
      }
      env {
        APP_ROLE       = "web"
        RUN_MIGRATIONS = "false"
        PORT           = "3000"
      }
      template {
        data        = <<-EOT
          {{ with nomadVar "nomad/jobs/tunebridge" }}{{ range $k, $v := . }}{{ $k }}={{ $v }}
          {{ end }}{{ end }}
        EOT
        destination = "secrets/env"
        env         = true
      }
      resources {
        cpu    = 500
        memory = 512
      }
    }
  }

  # Workers scale independently of the web tier; they hold no inbound traffic.
  group "worker" {
    count = 2

    # Spread across nodes so one node loss doesn't pause all syncs.
    spread { attribute = "${node.unique.id}" }

    task "worker" {
      driver = "docker"
      config {
        image = var.image
      }
      env {
        APP_ROLE           = "worker"
        RUN_MIGRATIONS     = "false"
        WORKER_CONCURRENCY = "4"
      }
      template {
        data        = <<-EOT
          {{ with nomadVar "nomad/jobs/tunebridge" }}{{ range $k, $v := . }}{{ $k }}={{ $v }}
          {{ end }}{{ end }}
        EOT
        destination = "secrets/env"
        env         = true
      }
      resources {
        cpu    = 500
        memory = 512
      }
      kill_timeout = "60s" # let pg-boss finish/return in-flight jobs on SIGTERM
    }
  }
}
