defmodule SymphonyElixirWeb.Router do
  @moduledoc """
  Router for Symphony's observability dashboard and API.
  """

  use Phoenix.Router
  import Phoenix.LiveView.Router

  alias SymphonyElixirWeb.StaticAssets

  @dashboard_css_asset_path StaticAssets.asset_path(:dashboard_css)
  @phoenix_html_js_asset_path StaticAssets.asset_path(:phoenix_html_js)
  @phoenix_js_asset_path StaticAssets.asset_path(:phoenix_js)
  @phoenix_live_view_js_asset_path StaticAssets.asset_path(:phoenix_live_view_js)

  pipeline :browser do
    plug(:fetch_session)
    plug(:fetch_live_flash)
    plug(:put_root_layout, html: {SymphonyElixirWeb.Layouts, :root})
    plug(:protect_from_forgery)
    plug(:put_secure_browser_headers)
  end

  scope "/", SymphonyElixirWeb do
    get("/dashboard.css", StaticAssetController, :show)
    get(@dashboard_css_asset_path, StaticAssetController, :show)
    get("/vendor/phoenix_html/phoenix_html.js", StaticAssetController, :show)
    get(@phoenix_html_js_asset_path, StaticAssetController, :show)
    get("/vendor/phoenix/phoenix.js", StaticAssetController, :show)
    get(@phoenix_js_asset_path, StaticAssetController, :show)
    get("/vendor/phoenix_live_view/phoenix_live_view.js", StaticAssetController, :show)
    get(@phoenix_live_view_js_asset_path, StaticAssetController, :show)
  end

  scope "/", SymphonyElixirWeb do
    pipe_through(:browser)

    live("/", DashboardLive, :index)
  end

  scope "/", SymphonyElixirWeb do
    get("/api/v1/state", ObservabilityApiController, :state)

    match(:*, "/", ObservabilityApiController, :method_not_allowed)
    match(:*, "/api/v1/state", ObservabilityApiController, :method_not_allowed)
    post("/api/v1/refresh", ObservabilityApiController, :refresh)
    match(:*, "/api/v1/refresh", ObservabilityApiController, :method_not_allowed)
    get("/api/v1/:issue_identifier", ObservabilityApiController, :issue)
    match(:*, "/api/v1/:issue_identifier", ObservabilityApiController, :method_not_allowed)
    match(:*, "/*path", ObservabilityApiController, :not_found)
  end
end
