defmodule SymphonyElixir.Config.Schema do
  @moduledoc false

  use Ecto.Schema

  import Ecto.Changeset

  alias SymphonyElixir.PathSafety

  @primary_key false

  @type t :: %__MODULE__{}

  defmodule StringOrMap do
    @moduledoc false
    @behaviour Ecto.Type

    @spec type() :: :map
    def type, do: :map

    @spec embed_as(term()) :: :self
    def embed_as(_format), do: :self

    @spec equal?(term(), term()) :: boolean()
    def equal?(left, right), do: left == right

    @spec cast(term()) :: {:ok, String.t() | map()} | :error
    def cast(value) when is_binary(value) or is_map(value), do: {:ok, value}
    def cast(_value), do: :error

    @spec load(term()) :: {:ok, String.t() | map()} | :error
    def load(value) when is_binary(value) or is_map(value), do: {:ok, value}
    def load(_value), do: :error

    @spec dump(term()) :: {:ok, String.t() | map()} | :error
    def dump(value) when is_binary(value) or is_map(value), do: {:ok, value}
    def dump(_value), do: :error
  end

  defmodule Dispatch do
    @moduledoc false
    use Ecto.Schema
    import Ecto.Changeset
    alias SymphonyElixir.Tracker.Dispatch, as: TrackerDispatch

    @primary_key false

    embedded_schema do
      field(:accept_unrouted, :boolean, default: true)
      field(:only_routes, {:array, :string})
      field(:route_label_prefix, :string, default: "Symphony:")
    end

    @spec changeset(%__MODULE__{}, map()) :: Ecto.Changeset.t()
    def changeset(schema, attrs) do
      schema
      |> cast(attrs, [:accept_unrouted, :only_routes, :route_label_prefix], empty_values: [])
      |> validate_required([:accept_unrouted, :route_label_prefix])
      |> validate_only_routes()
      |> update_change(:only_routes, &normalize_only_routes/1)
      |> update_change(:route_label_prefix, &String.trim/1)
    end

    defp validate_only_routes(changeset) do
      validate_change(changeset, :only_routes, fn :only_routes, routes ->
        if Enum.any?(routes, &(TrackerDispatch.normalize_route_name(&1) == "")) do
          [only_routes: "must not contain blank route names"]
        else
          []
        end
      end)
    end

    defp normalize_only_routes(nil), do: nil

    defp normalize_only_routes(routes) when is_list(routes) do
      routes
      |> Enum.map(&TrackerDispatch.normalize_route_name/1)
      |> Enum.uniq()
    end
  end

  defmodule Tracker do
    @moduledoc false
    use Ecto.Schema
    import Ecto.Changeset

    @primary_key false

    embedded_schema do
      field(:kind, :string)
      field(:endpoint, :string, default: "https://api.linear.app/graphql")
      field(:api_key, :string)
      field(:project_slug, :string)
      field(:assignee, :string)
      field(:active_states, {:array, :string}, default: ["Todo", "In Progress"])
      field(:terminal_states, {:array, :string}, default: ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"])
      embeds_one(:dispatch, Dispatch, on_replace: :update, defaults_to_struct: true)
    end

    @spec changeset(%__MODULE__{}, map()) :: Ecto.Changeset.t()
    def changeset(schema, attrs) do
      schema
      |> cast(
        attrs,
        [:kind, :endpoint, :api_key, :project_slug, :assignee, :active_states, :terminal_states],
        empty_values: []
      )
      |> cast_embed(:dispatch, with: &Dispatch.changeset/2)
    end
  end

  defmodule Polling do
    @moduledoc false
    use Ecto.Schema
    import Ecto.Changeset

    @primary_key false
    embedded_schema do
      field(:interval_ms, :integer, default: 30_000)
    end

    @spec changeset(%__MODULE__{}, map()) :: Ecto.Changeset.t()
    def changeset(schema, attrs) do
      schema
      |> cast(attrs, [:interval_ms], empty_values: [])
      |> validate_number(:interval_ms, greater_than: 0)
    end
  end

  defmodule Workspace do
    @moduledoc false
    use Ecto.Schema
    import Ecto.Changeset

    @primary_key false
    embedded_schema do
      field(:root, :string, default: Path.join(System.tmp_dir!(), "symphony_workspaces"))
    end

    @spec changeset(%__MODULE__{}, map()) :: Ecto.Changeset.t()
    def changeset(schema, attrs) do
      schema
      |> cast(attrs, [:root], empty_values: [])
    end
  end

  defmodule Worker do
    @moduledoc false
    use Ecto.Schema
    import Ecto.Changeset

    @primary_key false
    embedded_schema do
      field(:ssh_hosts, {:array, :string}, default: [])
      field(:ssh_timeout_ms, :integer, default: 60_000)
      field(:max_concurrent_agents_per_host, :integer)
    end

    @spec changeset(%__MODULE__{}, map()) :: Ecto.Changeset.t()
    def changeset(schema, attrs) do
      schema
      |> cast(attrs, [:ssh_hosts, :ssh_timeout_ms, :max_concurrent_agents_per_host], empty_values: [])
      |> validate_number(:ssh_timeout_ms, greater_than: 0)
      |> validate_number(:max_concurrent_agents_per_host, greater_than: 0)
    end
  end

  defmodule Agent do
    @moduledoc false
    use Ecto.Schema
    import Ecto.Changeset

    @primary_key false
    embedded_schema do
      field(:kind, :string, default: "codex")
      field(:max_concurrent_agents, :integer, default: 10)
      field(:max_turns, :integer, default: 20)
      field(:max_retry_backoff_ms, :integer, default: 300_000)
      field(:ensemble_size, :integer, default: 1)
    end

    @spec changeset(%__MODULE__{}, map()) :: Ecto.Changeset.t()
    def changeset(schema, attrs) do
      schema
      |> cast(
        attrs,
        [
          :kind,
          :max_concurrent_agents,
          :max_turns,
          :max_retry_backoff_ms,
          :ensemble_size
        ],
        empty_values: []
      )
      |> validate_inclusion(:kind, ["codex", "claude"])
      |> validate_number(:max_concurrent_agents, greater_than: 0)
      |> validate_number(:max_turns, greater_than: 0)
      |> validate_number(:max_retry_backoff_ms, greater_than: 0)
      |> validate_number(:ensemble_size, greater_than: 0)
    end
  end

  defmodule Codex do
    @moduledoc false
    use Ecto.Schema
    import Ecto.Changeset

    @primary_key false
    embedded_schema do
      field(:command, :string, default: "codex app-server")

      field(:approval_policy, StringOrMap,
        default: %{
          "reject" => %{
            "sandbox_approval" => true,
            "rules" => true,
            "mcp_elicitations" => true
          }
        }
      )

      field(:thread_sandbox, :string, default: "workspace-write")
      field(:turn_sandbox_policy, :map)
      field(:turn_timeout_ms, :integer, default: 3_600_000)
      field(:read_timeout_ms, :integer, default: 5_000)
      field(:stall_timeout_ms, :integer, default: 300_000)
    end

    @spec changeset(%__MODULE__{}, map()) :: Ecto.Changeset.t()
    def changeset(schema, attrs) do
      schema
      |> cast(
        attrs,
        [
          :command,
          :approval_policy,
          :thread_sandbox,
          :turn_sandbox_policy,
          :turn_timeout_ms,
          :read_timeout_ms,
          :stall_timeout_ms
        ],
        empty_values: []
      )
      |> validate_required([:command])
      |> validate_number(:turn_timeout_ms, greater_than: 0)
      |> validate_number(:read_timeout_ms, greater_than: 0)
      |> validate_number(:stall_timeout_ms, greater_than_or_equal_to: 0)
    end
  end

  defmodule Claude do
    @moduledoc false
    use Ecto.Schema
    import Ecto.Changeset

    @primary_key false
    embedded_schema do
      field(:command, :string, default: "claude")
      field(:model, :string, default: "claude-opus-4-6[1m]")
      field(:permission_mode, :string, default: "dontAsk")
      field(:turn_timeout_ms, :integer, default: 3_600_000)
      field(:stall_timeout_ms, :integer, default: 300_000)
      field(:strict_mcp_config, :boolean, default: true)
    end

    @spec changeset(%__MODULE__{}, map()) :: Ecto.Changeset.t()
    def changeset(schema, attrs) do
      schema
      |> cast(
        attrs,
        [
          :command,
          :model,
          :permission_mode,
          :turn_timeout_ms,
          :stall_timeout_ms,
          :strict_mcp_config
        ],
        empty_values: []
      )
      |> validate_required([:command, :permission_mode])
      |> validate_number(:turn_timeout_ms, greater_than: 0)
      |> validate_number(:stall_timeout_ms, greater_than_or_equal_to: 0)
    end
  end

  defmodule AgentOverride do
    @moduledoc false
    use Ecto.Schema
    import Ecto.Changeset

    @primary_key false
    embedded_schema do
      field(:kind, :string)
      field(:max_concurrent_agents, :integer)
      field(:max_turns, :integer)
      field(:max_retry_backoff_ms, :integer)
      field(:ensemble_size, :integer)
    end

    @spec allowed_fields() :: [atom()]
    def allowed_fields,
      do: [:kind, :max_concurrent_agents, :max_turns, :max_retry_backoff_ms, :ensemble_size]

    @spec changeset(%__MODULE__{}, map()) :: Ecto.Changeset.t()
    def changeset(schema, attrs) do
      schema
      |> cast(attrs, allowed_fields(), empty_values: [])
      |> validate_inclusion(:kind, ["codex", "claude"])
      |> validate_number(:max_concurrent_agents, greater_than: 0)
      |> validate_number(:max_turns, greater_than: 0)
      |> validate_number(:max_retry_backoff_ms, greater_than: 0)
      |> validate_number(:ensemble_size, greater_than: 0)
    end
  end

  defmodule CodexOverride do
    @moduledoc false
    use Ecto.Schema
    import Ecto.Changeset

    @primary_key false
    embedded_schema do
      field(:command, :string)
      field(:approval_policy, StringOrMap)
      field(:thread_sandbox, :string)
      field(:turn_sandbox_policy, :map)
      field(:turn_timeout_ms, :integer)
      field(:read_timeout_ms, :integer)
      field(:stall_timeout_ms, :integer)
    end

    @spec allowed_fields() :: [atom()]
    def allowed_fields,
      do: [
        :command,
        :approval_policy,
        :thread_sandbox,
        :turn_sandbox_policy,
        :turn_timeout_ms,
        :read_timeout_ms,
        :stall_timeout_ms
      ]

    @spec changeset(%__MODULE__{}, map()) :: Ecto.Changeset.t()
    def changeset(schema, attrs) do
      schema
      |> cast(attrs, allowed_fields(), empty_values: [])
      |> validate_number(:turn_timeout_ms, greater_than: 0)
      |> validate_number(:read_timeout_ms, greater_than: 0)
      |> validate_number(:stall_timeout_ms, greater_than_or_equal_to: 0)
    end
  end

  defmodule ClaudeOverride do
    @moduledoc false
    use Ecto.Schema
    import Ecto.Changeset

    @primary_key false
    embedded_schema do
      field(:command, :string)
      field(:model, :string)
      field(:permission_mode, :string)
      field(:turn_timeout_ms, :integer)
      field(:stall_timeout_ms, :integer)
      field(:strict_mcp_config, :boolean)
    end

    @spec allowed_fields() :: [atom()]
    def allowed_fields,
      do: [:command, :model, :permission_mode, :turn_timeout_ms, :stall_timeout_ms, :strict_mcp_config]

    @spec changeset(%__MODULE__{}, map()) :: Ecto.Changeset.t()
    def changeset(schema, attrs) do
      schema
      |> cast(attrs, allowed_fields(), empty_values: [])
      |> validate_number(:turn_timeout_ms, greater_than: 0)
      |> validate_number(:stall_timeout_ms, greater_than_or_equal_to: 0)
    end
  end

  defmodule Hooks do
    @moduledoc false
    use Ecto.Schema
    import Ecto.Changeset

    @primary_key false
    embedded_schema do
      field(:after_create, :string)
      field(:before_run, :string)
      field(:after_run, :string)
      field(:before_remove, :string)
      field(:timeout_ms, :integer, default: 60_000)
    end

    @spec changeset(%__MODULE__{}, map()) :: Ecto.Changeset.t()
    def changeset(schema, attrs) do
      schema
      |> cast(attrs, [:after_create, :before_run, :after_run, :before_remove, :timeout_ms], empty_values: [])
      |> validate_number(:timeout_ms, greater_than: 0)
    end
  end

  defmodule Observability do
    @moduledoc false
    use Ecto.Schema
    import Ecto.Changeset

    @primary_key false
    embedded_schema do
      field(:dashboard_enabled, :boolean, default: true)
      field(:refresh_ms, :integer, default: 1_000)
      field(:render_interval_ms, :integer, default: 16)
    end

    @spec changeset(%__MODULE__{}, map()) :: Ecto.Changeset.t()
    def changeset(schema, attrs) do
      schema
      |> cast(attrs, [:dashboard_enabled, :refresh_ms, :render_interval_ms], empty_values: [])
      |> validate_number(:refresh_ms, greater_than: 0)
      |> validate_number(:render_interval_ms, greater_than: 0)
    end
  end

  defmodule Server do
    @moduledoc false
    use Ecto.Schema
    import Ecto.Changeset

    @primary_key false
    embedded_schema do
      field(:port, :integer)
      field(:host, :string, default: "127.0.0.1")
    end

    @spec changeset(%__MODULE__{}, map()) :: Ecto.Changeset.t()
    def changeset(schema, attrs) do
      schema
      |> cast(attrs, [:port, :host], empty_values: [])
      |> validate_number(:port, greater_than_or_equal_to: 0)
    end
  end

  embedded_schema do
    embeds_one(:tracker, Tracker, on_replace: :update, defaults_to_struct: true)
    embeds_one(:polling, Polling, on_replace: :update, defaults_to_struct: true)
    embeds_one(:workspace, Workspace, on_replace: :update, defaults_to_struct: true)
    embeds_one(:worker, Worker, on_replace: :update, defaults_to_struct: true)
    embeds_one(:agent, Agent, on_replace: :update, defaults_to_struct: true)
    embeds_one(:codex, Codex, on_replace: :update, defaults_to_struct: true)
    embeds_one(:claude, Claude, on_replace: :update, defaults_to_struct: true)
    embeds_one(:hooks, Hooks, on_replace: :update, defaults_to_struct: true)
    embeds_one(:observability, Observability, on_replace: :update, defaults_to_struct: true)
    embeds_one(:server, Server, on_replace: :update, defaults_to_struct: true)
    field(:status_overrides, :map, default: %{})
  end

  @spec parse(map()) :: {:ok, %__MODULE__{}} | {:error, {:invalid_workflow_config, String.t()}}
  def parse(config) when is_map(config) do
    with {:ok, normalized_config} <-
           config
           |> normalize_keys()
           |> drop_nil_values()
           |> normalize_config() do
      normalized_config
      |> changeset()
      |> apply_action(:validate)
      |> case do
        {:ok, settings} ->
          {:ok, finalize_settings(settings)}

        {:error, changeset} ->
          {:error, {:invalid_workflow_config, format_errors(changeset)}}
      end
    end
  end

  @spec resolve_status_override(%__MODULE__{}, String.t() | term()) :: %__MODULE__{}
  def resolve_status_override(%__MODULE__{} = settings, state_name) when is_binary(state_name) do
    normalized_state = normalize_issue_state(state_name)

    case Map.get(settings.status_overrides, normalized_state) do
      nil ->
        settings

      override when is_map(override) ->
        settings
        |> merge_override_section(:agent, Map.get(override, :agent))
        |> merge_override_section(:codex, Map.get(override, :codex))
        |> merge_override_section(:claude, Map.get(override, :claude))
    end
  end

  def resolve_status_override(%__MODULE__{} = settings, _state_name), do: settings

  @spec resolve_turn_sandbox_policy(%__MODULE__{}, Path.t() | nil) :: map()
  def resolve_turn_sandbox_policy(settings, workspace \\ nil) do
    case settings.codex.turn_sandbox_policy do
      %{} = policy ->
        policy

      _ ->
        workspace
        |> default_workspace_root(settings.workspace.root)
        |> expand_local_workspace_root()
        |> default_turn_sandbox_policy()
    end
  end

  @spec resolve_runtime_turn_sandbox_policy(%__MODULE__{}, Path.t() | nil, keyword()) ::
          {:ok, map()} | {:error, term()}
  def resolve_runtime_turn_sandbox_policy(settings, workspace \\ nil, opts \\ []) do
    case settings.codex.turn_sandbox_policy do
      %{} = policy ->
        {:ok, policy}

      _ ->
        workspace
        |> default_workspace_root(settings.workspace.root)
        |> default_runtime_turn_sandbox_policy(opts)
    end
  end

  @spec normalize_issue_state(String.t()) :: String.t()
  def normalize_issue_state(state_name) when is_binary(state_name) do
    state_name
    |> String.trim()
    |> String.downcase()
  end

  @doc false
  @spec normalize_state_limits(nil | map()) :: map()
  def normalize_state_limits(nil), do: %{}

  def normalize_state_limits(limits) when is_map(limits) do
    Enum.reduce(limits, %{}, fn {state_name, limit}, acc ->
      Map.put(acc, normalize_issue_state(to_string(state_name)), limit)
    end)
  end

  @doc false
  @spec validate_state_limits(Ecto.Changeset.t(), atom()) :: Ecto.Changeset.t()
  def validate_state_limits(changeset, field) do
    validate_change(changeset, field, fn ^field, limits ->
      Enum.flat_map(limits, fn {state_name, limit} ->
        cond do
          to_string(state_name) == "" ->
            [{field, "state names must not be blank"}]

          not is_integer(limit) or limit <= 0 ->
            [{field, "limits must be positive integers"}]

          true ->
            []
        end
      end)
    end)
  end

  defp changeset(attrs) do
    %__MODULE__{}
    |> cast(attrs, [:status_overrides], empty_values: [])
    |> cast_embed(:tracker, with: &Tracker.changeset/2)
    |> cast_embed(:polling, with: &Polling.changeset/2)
    |> cast_embed(:workspace, with: &Workspace.changeset/2)
    |> cast_embed(:worker, with: &Worker.changeset/2)
    |> cast_embed(:agent, with: &Agent.changeset/2)
    |> cast_embed(:codex, with: &Codex.changeset/2)
    |> cast_embed(:claude, with: &Claude.changeset/2)
    |> cast_embed(:hooks, with: &Hooks.changeset/2)
    |> cast_embed(:observability, with: &Observability.changeset/2)
    |> cast_embed(:server, with: &Server.changeset/2)
  end

  defp normalize_config(config) when is_map(config) do
    with :ok <- reject_legacy_agent_state_limits(config),
         {:ok, status_overrides} <- normalize_status_overrides(Map.get(config, "status_overrides")) do
      {:ok, Map.put(config, "status_overrides", status_overrides)}
    end
  end

  defp reject_legacy_agent_state_limits(config) when is_map(config) do
    case get_in(config, ["agent", "max_concurrent_agents_by_state"]) do
      nil ->
        :ok

      _value ->
        {:error, {:invalid_workflow_config, "agent.max_concurrent_agents_by_state has been removed; use status_overrides.<state>.agent.max_concurrent_agents instead"}}
    end
  end

  defp normalize_status_overrides(nil), do: {:ok, %{}}

  defp normalize_status_overrides(status_overrides) when is_map(status_overrides) do
    Enum.reduce_while(status_overrides, {:ok, %{}}, fn {state_name, override}, {:ok, acc} ->
      case normalize_status_override_entry(state_name, override) do
        {:ok, normalized_state, normalized_override} ->
          {:cont, {:ok, Map.put(acc, normalized_state, normalized_override)}}

        {:error, reason} ->
          {:halt, {:error, {:invalid_workflow_config, reason}}}
      end
    end)
  end

  defp normalize_status_overrides(_status_overrides) do
    {:error, {:invalid_workflow_config, "status_overrides must be a map"}}
  end

  defp normalize_status_override_entry(state_name, override) do
    normalized_state = normalize_issue_state(to_string(state_name))
    path = "status_overrides.#{normalized_state}"

    cond do
      normalized_state == "" ->
        {:error, "status_overrides state names must not be blank"}

      not is_map(override) ->
        {:error, "#{path} must be a map"}

      true ->
        with :ok <- ensure_allowed_keys(override, ~w(agent codex claude), path),
             {:ok, agent_override} <-
               normalize_override_section(Map.get(override, "agent"), AgentOverride, "#{path}.agent"),
             {:ok, codex_override} <-
               normalize_override_section(Map.get(override, "codex"), CodexOverride, "#{path}.codex"),
             {:ok, claude_override} <-
               normalize_override_section(Map.get(override, "claude"), ClaudeOverride, "#{path}.claude") do
          normalized_override =
            %{}
            |> maybe_put_override(:agent, agent_override)
            |> maybe_put_override(:codex, codex_override)
            |> maybe_put_override(:claude, claude_override)

          {:ok, normalized_state, normalized_override}
        end
    end
  end

  defp normalize_override_section(nil, _module, _path), do: {:ok, nil}

  defp normalize_override_section(raw_override, module, path) when is_map(raw_override) do
    allowed_keys =
      module.allowed_fields()
      |> Enum.map(&Atom.to_string/1)

    with :ok <- ensure_allowed_keys(raw_override, allowed_keys, path) do
      changeset = module.changeset(struct(module), raw_override)

      case apply_action(changeset, :validate) do
        {:ok, override} ->
          {:ok, normalize_override_map(override)}

        {:error, changeset} ->
          {:error, format_errors(changeset, path)}
      end
    end
  end

  defp normalize_override_section(_raw_override, _module, path) do
    {:error, "#{path} must be a map"}
  end

  defp ensure_allowed_keys(value, allowed_keys, path) when is_map(value) do
    unknown_keys =
      value
      |> Map.keys()
      |> Enum.map(&to_string/1)
      |> Enum.reject(&(&1 in allowed_keys))

    case unknown_keys do
      [] -> :ok
      _ -> {:error, "#{path} contains unsupported keys: #{Enum.join(Enum.sort(unknown_keys), ", ")}"}
    end
  end

  defp normalize_override_map(override) do
    override
    |> Map.from_struct()
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
    |> then(fn override_map ->
      override_map
      |> maybe_normalize_override_map_value(:approval_policy)
      |> maybe_normalize_override_map_value(:turn_sandbox_policy)
    end)
  end

  defp maybe_normalize_override_map_value(override_map, key) do
    case Map.fetch(override_map, key) do
      {:ok, value} when is_map(value) -> Map.put(override_map, key, normalize_keys(value))
      _ -> override_map
    end
  end

  defp maybe_put_override(override, _key, nil), do: override
  defp maybe_put_override(override, key, value), do: Map.put(override, key, value)

  defp merge_override_section(settings, _section, nil), do: settings

  defp merge_override_section(settings, :codex, override) when is_map(override) do
    current = Map.fetch!(settings, :codex)

    merged_override =
      override
      |> maybe_deep_merge_override_field(current, :approval_policy)
      |> maybe_deep_merge_override_field(current, :turn_sandbox_policy)

    Map.put(settings, :codex, struct(current, merged_override))
  end

  defp merge_override_section(settings, section, override) when is_map(override) do
    current = Map.fetch!(settings, section)
    Map.put(settings, section, struct(current, override))
  end

  defp maybe_deep_merge_override_field(override, current, field) do
    case {Map.get(current, field), Map.get(override, field)} do
      {%{} = current_value, %{} = override_value} ->
        Map.put(override, field, deep_merge_maps(current_value, override_value))

      _ ->
        override
    end
  end

  defp deep_merge_maps(current, override) do
    Map.merge(current, override, fn _key, current_value, override_value ->
      if is_map(current_value) and is_map(override_value) do
        deep_merge_maps(current_value, override_value)
      else
        override_value
      end
    end)
  end

  defp finalize_settings(settings) do
    workspace_root =
      case System.get_env("SYMPHONY_WORKSPACE_ROOT") do
        value when is_binary(value) and value != "" -> value
        _ -> settings.workspace.root
      end

    tracker = %{
      settings.tracker
      | api_key: resolve_secret_setting(settings.tracker.api_key, System.get_env("LINEAR_API_KEY")),
        assignee: resolve_secret_setting(settings.tracker.assignee, System.get_env("LINEAR_ASSIGNEE"))
    }

    workspace = %{
      settings.workspace
      | root: resolve_path_value(workspace_root, Path.join(System.tmp_dir!(), "symphony_workspaces"))
    }

    codex = %{
      settings.codex
      | approval_policy: normalize_keys(settings.codex.approval_policy),
        turn_sandbox_policy: normalize_optional_map(settings.codex.turn_sandbox_policy)
    }

    status_overrides =
      settings.status_overrides
      |> Enum.map(fn {state_name, override} ->
        normalized_override =
          override
          |> maybe_normalize_override_section(:codex)

        {state_name, normalized_override}
      end)
      |> Map.new()

    %{settings | tracker: tracker, workspace: workspace, codex: codex, status_overrides: status_overrides}
  end

  defp maybe_normalize_override_section(override, section) when is_map(override) do
    case Map.get(override, section) do
      nil ->
        override

      section_override ->
        Map.put(
          override,
          section,
          section_override
          |> maybe_normalize_override_field(:approval_policy)
          |> maybe_normalize_override_field(:turn_sandbox_policy)
        )
    end
  end

  defp maybe_normalize_override_field(override, field) when is_map(override) do
    case Map.fetch(override, field) do
      {:ok, value} when is_map(value) -> Map.put(override, field, normalize_keys(value))
      _ -> override
    end
  end

  defp normalize_keys(value) when is_map(value) do
    Enum.reduce(value, %{}, fn {key, raw_value}, normalized ->
      Map.put(normalized, normalize_key(key), normalize_keys(raw_value))
    end)
  end

  defp normalize_keys(value) when is_list(value), do: Enum.map(value, &normalize_keys/1)
  defp normalize_keys(value), do: value

  defp normalize_optional_map(nil), do: nil
  defp normalize_optional_map(value) when is_map(value), do: normalize_keys(value)

  defp normalize_key(value) when is_atom(value), do: Atom.to_string(value)
  defp normalize_key(value), do: to_string(value)

  defp drop_nil_values(value) when is_map(value) do
    Enum.reduce(value, %{}, fn {key, nested}, acc ->
      case drop_nil_values(nested) do
        nil -> acc
        normalized -> Map.put(acc, key, normalized)
      end
    end)
  end

  defp drop_nil_values(value) when is_list(value), do: Enum.map(value, &drop_nil_values/1)
  defp drop_nil_values(value), do: value

  defp resolve_secret_setting(nil, fallback), do: normalize_secret_value(fallback)

  defp resolve_secret_setting(value, fallback) when is_binary(value) do
    case resolve_env_value(value, fallback) do
      resolved when is_binary(resolved) -> normalize_secret_value(resolved)
      resolved -> resolved
    end
  end

  defp resolve_path_value(value, default) when is_binary(value) do
    case normalize_path_token(value) do
      :missing ->
        default

      "" ->
        default

      path ->
        path
    end
  end

  defp resolve_env_value(value, fallback) when is_binary(value) do
    case env_reference_name(value) do
      {:ok, env_name} ->
        case System.get_env(env_name) do
          nil -> fallback
          "" -> nil
          env_value -> env_value
        end

      :error ->
        value
    end
  end

  defp normalize_path_token(value) when is_binary(value) do
    case env_reference_name(value) do
      {:ok, env_name} -> resolve_env_token(env_name)
      :error -> value
    end
  end

  defp env_reference_name("$" <> env_name) do
    if String.match?(env_name, ~r/^[A-Za-z_][A-Za-z0-9_]*$/) do
      {:ok, env_name}
    else
      :error
    end
  end

  defp env_reference_name(_value), do: :error

  defp resolve_env_token(env_name) do
    case System.get_env(env_name) do
      nil -> :missing
      env_value -> env_value
    end
  end

  defp normalize_secret_value(value) when is_binary(value) do
    if value == "", do: nil, else: value
  end

  defp normalize_secret_value(_value), do: nil

  defp default_turn_sandbox_policy(workspace) do
    %{
      "type" => "workspaceWrite",
      "writableRoots" => [workspace],
      "readOnlyAccess" => %{"type" => "fullAccess"},
      "networkAccess" => false,
      "excludeTmpdirEnvVar" => false,
      "excludeSlashTmp" => false
    }
  end

  defp default_runtime_turn_sandbox_policy(workspace_root, opts) when is_binary(workspace_root) do
    if Keyword.get(opts, :remote, false) do
      {:ok, default_turn_sandbox_policy(workspace_root)}
    else
      with expanded_workspace_root <- expand_local_workspace_root(workspace_root),
           {:ok, canonical_workspace_root} <- PathSafety.canonicalize(expanded_workspace_root) do
        {:ok, default_turn_sandbox_policy(canonical_workspace_root)}
      end
    end
  end

  defp default_runtime_turn_sandbox_policy(workspace_root, _opts) do
    {:error, {:unsafe_turn_sandbox_policy, {:invalid_workspace_root, workspace_root}}}
  end

  defp default_workspace_root(workspace, _fallback) when is_binary(workspace) and workspace != "",
    do: workspace

  defp default_workspace_root(nil, fallback), do: fallback
  defp default_workspace_root("", fallback), do: fallback
  defp default_workspace_root(workspace, _fallback), do: workspace

  defp expand_local_workspace_root(workspace_root)
       when is_binary(workspace_root) and workspace_root != "" do
    Path.expand(workspace_root)
  end

  defp expand_local_workspace_root(_workspace_root) do
    Path.expand(Path.join(System.tmp_dir!(), "symphony_workspaces"))
  end

  defp format_errors(changeset, prefix \\ nil) do
    changeset
    |> traverse_errors(&translate_error/1)
    |> flatten_errors(prefix)
    |> Enum.join(", ")
  end

  defp flatten_errors(errors, prefix) when is_map(errors) do
    Enum.flat_map(errors, fn {key, value} ->
      next_prefix =
        case prefix do
          nil -> to_string(key)
          current -> current <> "." <> to_string(key)
        end

      flatten_errors(value, next_prefix)
    end)
  end

  defp flatten_errors(errors, prefix) when is_list(errors) do
    Enum.map(errors, &(prefix <> " " <> &1))
  end

  defp translate_error({message, options}) do
    Enum.reduce(options, message, fn {key, value}, acc ->
      String.replace(acc, "%{#{key}}", error_value_to_string(value))
    end)
  end

  defp error_value_to_string(value) when is_atom(value), do: Atom.to_string(value)
  defp error_value_to_string(value), do: inspect(value)
end
