import Config

config :phoenix, :json_library, Jason

env_or_default = fn env_name, default ->
  case System.get_env(env_name) do
    value when is_binary(value) and value != "" -> value
    _ -> default
  end
end

default_secret_key_base = String.duplicate("s", 64)
default_live_view_signing_salt = "symphony-live-view"

config :symphony_elixir, SymphonyElixirWeb.Endpoint,
  adapter: Bandit.PhoenixAdapter,
  url: [host: "localhost"],
  render_errors: [
    formats: [html: SymphonyElixirWeb.ErrorHTML, json: SymphonyElixirWeb.ErrorJSON],
    layout: false
  ],
  pubsub_server: SymphonyElixir.PubSub,
  live_view: [
    signing_salt: env_or_default.("SYMPHONY_LIVE_VIEW_SIGNING_SALT", default_live_view_signing_salt)
  ],
  secret_key_base: env_or_default.("SYMPHONY_SECRET_KEY_BASE", default_secret_key_base),
  check_origin: false,
  server: false

env_config = Path.join(__DIR__, "#{config_env()}.exs")

if File.exists?(env_config) do
  import_config "#{config_env()}.exs"
end
