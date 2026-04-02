defmodule SymphonyElixir.Claude.Subprocess do
  @moduledoc false

  @behaviour SymphonyElixir.AgentExecutor

  alias SymphonyElixir.Claude.{CapabilityProbe, Mcp}
  alias SymphonyElixir.{Config, SSH}

  @port_line_bytes 1_048_576

  @type session :: %{
          agent_kind: String.t(),
          capabilities: CapabilityProbe.t(),
          config_path: String.t(),
          metadata: map(),
          pending_line: String.t(),
          port: port(),
          resume_id: String.t() | nil,
          session_id: String.t() | nil,
          stall_timeout_ms: non_neg_integer(),
          turn_timeout_ms: pos_integer(),
          worker_host: String.t() | nil,
          workspace: String.t()
        }

  @impl true
  def start_session(workspace, opts \\ []) do
    worker_host = Keyword.get(opts, :worker_host)

    with {:ok, capabilities} <- CapabilityProbe.probe(worker_host: worker_host),
         :ok <- validate_capabilities(capabilities),
         {:ok, %{config_path: config_path, sidecar_path: _sidecar_path}} <- Mcp.prepare(workspace, worker_host) do
      resume_metadata = Keyword.get(opts, :resume_metadata, %{})
      issue = Keyword.get(opts, :issue)
      settings = Config.claude_runtime_settings!()

      base_session = %{
        agent_kind: "claude",
        capabilities: capabilities,
        config_path: config_path,
        metadata: %{},
        pending_line: "",
        port: nil,
        resume_id: Map.get(resume_metadata, :resume_id),
        session_id: Map.get(resume_metadata, :session_id),
        stall_timeout_ms: settings.stall_timeout_ms,
        turn_timeout_ms: settings.turn_timeout_ms,
        worker_host: worker_host,
        workspace: workspace
      }

      case start_port(base_session, issue) do
        {:ok, port, metadata} ->
          {:ok, %{base_session | port: port, metadata: metadata}}

        {:error, reason} ->
          {:error, reason}
      end
    end
  end

  @impl true
  def run_turn(session, prompt, _issue, opts \\ []) when is_map(session) and is_binary(prompt) do
    on_message = Keyword.get(opts, :on_message, &default_on_message/1)

    with {:ok, session} <- flush_pending_messages(session, on_message),
         {:ok, session} <- send_turn_input(session, prompt, on_message),
         {:ok, session, result} <- await_turn_completion(session, on_message) do
      {:ok, session, result}
    end
  end

  @impl true
  def stop_session(%{port: port}) when is_port(port) do
    stop_port(port)
  end

  def stop_session(_session), do: :ok

  @impl true
  def resume_metadata(session) when is_map(session) do
    %{
      agent_kind: "claude",
      resume_id: Map.get(session, :resume_id),
      session_id: Map.get(session, :session_id)
    }
  end

  defp validate_capabilities(%CapabilityProbe{
         print: true,
         stream_json: true,
         permission_mode: true,
         mcp_config: true,
         input_format: true
       }),
       do: :ok

  defp validate_capabilities(capabilities), do: {:error, {:unsupported_claude_capabilities, capabilities}}

  defp start_port(%{worker_host: nil, workspace: workspace} = session, issue) do
    executable = System.find_executable("bash")

    if is_nil(executable) do
      {:error, :bash_not_found}
    else
      port =
        Port.open(
          {:spawn_executable, String.to_charlist(executable)},
          [
            :binary,
            :exit_status,
            :stderr_to_stdout,
            args: [~c"-lc", String.to_charlist(launch_command(session, issue))],
            cd: String.to_charlist(workspace),
            line: @port_line_bytes
          ]
        )

      {:ok, port, port_metadata(port, session.worker_host)}
    end
  end

  defp start_port(%{worker_host: worker_host} = session, issue) when is_binary(worker_host) do
    case SSH.start_port(worker_host, remote_launch_command(session, issue), line: @port_line_bytes) do
      {:ok, port} -> {:ok, port, port_metadata(port, worker_host)}
      {:error, reason} -> {:error, reason}
    end
  end

  defp launch_command(session, issue) do
    settings = Config.claude_runtime_settings!()
    argv = launch_argv(session, issue, settings)
    "exec #{settings.command} #{Enum.map_join(argv, " ", &SSH.shell_escape/1)}"
  end

  defp remote_launch_command(%{workspace: workspace} = session, issue) when is_binary(workspace) do
    "cd #{SSH.shell_escape(workspace)} && #{launch_command(session, issue)}"
  end

  defp launch_argv(session, issue, settings) do
    []
    |> Kernel.++(["--print"])
    |> maybe_add_flag(session.capabilities.verbose, "--verbose")
    |> Kernel.++(["--output-format=stream-json", "--input-format=stream-json"])
    |> maybe_add_arg("--permission-mode", settings.permission_mode)
    |> maybe_add_arg("--allowedTools", Enum.join(Mcp.allowed_tools(), ","))
    |> maybe_add_arg("--model", settings.model)
    |> maybe_add_arg("-n", issue_name(issue))
    |> maybe_add_arg("--mcp-config", session.config_path)
    |> maybe_add_flag(settings.strict_mcp_config, "--strict-mcp-config")
    |> maybe_add_arg("--resume", session.resume_id)
  end

  defp issue_name(%{identifier: identifier, title: title})
       when is_binary(identifier) and is_binary(title) do
    "#{identifier}: #{title}"
  end

  defp issue_name(%{identifier: identifier}) when is_binary(identifier), do: identifier
  defp issue_name(_issue), do: nil

  defp maybe_add_arg(argv, _flag, nil), do: argv
  defp maybe_add_arg(argv, _flag, ""), do: argv
  defp maybe_add_arg(argv, flag, value), do: argv ++ [flag, value]

  defp maybe_add_flag(argv, true, flag), do: argv ++ [flag]
  defp maybe_add_flag(argv, _value, _flag), do: argv

  defp flush_pending_messages(session, on_message) do
    do_flush_pending_messages(session, on_message)
  end

  defp do_flush_pending_messages(%{port: port, pending_line: pending_line} = session, on_message) do
    receive do
      {^port, {:data, {:eol, chunk}}} ->
        case process_nonterminal_line(%{session | pending_line: ""}, pending_line <> to_string(chunk), on_message) do
          {:ok, session} -> do_flush_pending_messages(session, on_message)
          {:error, reason} -> {:error, reason}
        end

      {^port, {:data, {:noeol, chunk}}} ->
        do_flush_pending_messages(%{session | pending_line: pending_line <> to_string(chunk)}, on_message)

      {^port, {:exit_status, status}} ->
        {:error, {:port_exit, status}}
    after
      0 ->
        {:ok, session}
    end
  end

  defp process_nonterminal_line(session, data, on_message) do
    payload_string = to_string(data)

    case Jason.decode(payload_string) do
      {:ok, payload} when is_map(payload) ->
        case normalize_stream_event(payload, payload_string, session.metadata, session) do
          {:continue, session, update} ->
            emit_update(on_message, update)
            {:ok, %{session | pending_line: ""}}

          {:done, session, _update, _result} ->
            {:ok, %{session | pending_line: ""}}

          {:error, reason, update} ->
            emit_update(on_message, update)
            {:error, reason}

          {:ignore, session} ->
            {:ok, %{session | pending_line: ""}}
        end

      {:error, _reason} ->
        update = base_update(session, session.metadata, :malformed, payload_string, payload_string)
        emit_update(on_message, update)
        {:ok, %{session | pending_line: ""}}
    end
  end

  defp send_turn_input(session, prompt, on_message) do
    payload = %{
      "type" => "user",
      "message" => %{
        "role" => "user",
        "content" => prompt
      },
      "parent_tool_use_id" => nil
    }

    encoded_payload = Jason.encode!(payload)

    if send_port_command(session.port, encoded_payload <> "\n") do
      update = base_update(session, session.metadata, :turn_started, payload, encoded_payload)
      emit_update(on_message, update)
      {:ok, session}
    else
      {:error, {:port_command_failed, :closed}}
    end
  end

  defp await_turn_completion(session, on_message) do
    started_at_ms = System.monotonic_time(:millisecond)
    receive_loop(session, on_message, started_at_ms, started_at_ms)
  end

  defp receive_loop(%{port: port, pending_line: pending_line} = session, on_message, started_at_ms, last_output_at_ms) do
    timeout_ms = next_timeout_ms(session, started_at_ms, last_output_at_ms)

    receive do
      {^port, {:data, {:eol, chunk}}} ->
        handle_line(
          %{session | pending_line: ""},
          pending_line <> to_string(chunk),
          on_message,
          started_at_ms,
          System.monotonic_time(:millisecond)
        )

      {^port, {:data, {:noeol, chunk}}} ->
        receive_loop(%{session | pending_line: pending_line <> to_string(chunk)}, on_message, started_at_ms, last_output_at_ms)

      {^port, {:exit_status, status}} ->
        {:error, {:port_exit, status}}
    after
      timeout_ms ->
        {:error, timeout_reason(session.turn_timeout_ms, session.stall_timeout_ms, started_at_ms, last_output_at_ms)}
    end
  end

  defp handle_line(session, data, on_message, started_at_ms, last_output_at_ms) do
    payload_string = to_string(data)

    case Jason.decode(payload_string) do
      {:ok, payload} when is_map(payload) ->
        case normalize_stream_event(payload, payload_string, session.metadata, session) do
          {:continue, updated_session, update} ->
            emit_update(on_message, update)
            receive_loop(%{updated_session | pending_line: ""}, on_message, started_at_ms, last_output_at_ms)

          {:done, updated_session, update, result} ->
            emit_update(on_message, update)
            {:ok, %{updated_session | pending_line: ""}, result}

          {:error, reason, update} ->
            emit_update(on_message, update)
            {:error, reason}

          {:ignore, updated_session} ->
            receive_loop(%{updated_session | pending_line: ""}, on_message, started_at_ms, last_output_at_ms)
        end

      {:error, _reason} ->
        update = base_update(session, session.metadata, :malformed, payload_string, payload_string)
        emit_update(on_message, update)
        receive_loop(%{session | pending_line: ""}, on_message, started_at_ms, last_output_at_ms)
    end
  end

  defp normalize_stream_event(%{"type" => "system", "subtype" => "init"} = payload, raw, metadata, session) do
    session = update_session_from_payload(session, payload)
    update = base_update(session, metadata, :session_started, payload, raw)
    {:continue, session, update}
  end

  defp normalize_stream_event(%{"type" => "assistant"} = payload, raw, metadata, session) do
    session = update_session_from_payload(session, payload)

    event =
      case assistant_event(payload) do
        :tool_use_requested -> :tool_use_requested
        _ -> :assistant_message
      end

    update =
      session
      |> base_update(metadata, event, payload, raw)
      |> maybe_put_usage(payload)

    {:continue, session, update}
  end

  defp normalize_stream_event(%{"type" => "user", "tool_use_result" => _} = payload, raw, metadata, session) do
    session = update_session_from_payload(session, payload)
    update = base_update(session, metadata, :tool_result, payload, raw)
    {:continue, session, update}
  end

  defp normalize_stream_event(%{"type" => "rate_limit_event"} = payload, raw, metadata, session) do
    session = update_session_from_payload(session, payload)
    update = base_update(session, metadata, :rate_limit, payload, raw)
    {:continue, session, update}
  end

  defp normalize_stream_event(%{"type" => "stream_event"} = payload, raw, metadata, session) do
    session = update_session_from_payload(session, payload)
    update = base_update(session, metadata, :notification, payload, raw)
    {:continue, session, update}
  end

  defp normalize_stream_event(%{"type" => "system"} = payload, raw, metadata, session) do
    session = update_session_from_payload(session, payload)
    update = base_update(session, metadata, :notification, payload, raw)
    {:continue, session, update}
  end

  defp normalize_stream_event(%{"type" => "tool_progress"} = payload, raw, metadata, session) do
    session = update_session_from_payload(session, payload)
    update = base_update(session, metadata, :notification, payload, raw)
    {:continue, session, update}
  end

  defp normalize_stream_event(%{"type" => "tool_use_summary"} = payload, raw, metadata, session) do
    session = update_session_from_payload(session, payload)
    update = base_update(session, metadata, :notification, payload, raw)
    {:continue, session, update}
  end

  defp normalize_stream_event(%{"type" => "streamlined_text"} = payload, raw, metadata, session) do
    session = update_session_from_payload(session, payload)
    update = base_update(session, metadata, :assistant_message, payload, raw)
    {:continue, session, update}
  end

  defp normalize_stream_event(%{"type" => "streamlined_tool_use_summary"} = payload, raw, metadata, session) do
    session = update_session_from_payload(session, payload)
    update = base_update(session, metadata, :notification, payload, raw)
    {:continue, session, update}
  end

  defp normalize_stream_event(%{"type" => "auth_status"} = payload, raw, metadata, session) do
    session = update_session_from_payload(session, payload)
    update = base_update(session, metadata, :notification, payload, raw)
    {:continue, session, update}
  end

  defp normalize_stream_event(%{"type" => "prompt_suggestion"} = payload, raw, metadata, session) do
    session = update_session_from_payload(session, payload)
    update = base_update(session, metadata, :notification, payload, raw)
    {:continue, session, update}
  end

  defp normalize_stream_event(%{"type" => "control_request"} = payload, raw, metadata, session) do
    session = update_session_from_payload(session, payload)
    update = base_update(session, metadata, :unsupported_control_protocol, payload, raw)
    {:error, {:unsupported_control_protocol, payload}, update}
  end

  defp normalize_stream_event(%{"type" => "control_cancel_request"} = payload, raw, metadata, session) do
    session = update_session_from_payload(session, payload)
    update = base_update(session, metadata, :notification, payload, raw)
    {:continue, session, update}
  end

  defp normalize_stream_event(%{"type" => "control_response"} = payload, raw, metadata, session) do
    session = update_session_from_payload(session, payload)
    update = base_update(session, metadata, :notification, payload, raw)
    {:continue, session, update}
  end

  defp normalize_stream_event(%{"type" => "keep_alive"} = _payload, _raw, _metadata, session) do
    {:ignore, session}
  end

  defp normalize_stream_event(%{"type" => "result", "is_error" => false} = payload, raw, metadata, session) do
    session = update_session_from_payload(session, payload)

    update =
      session
      |> base_update(metadata, :turn_completed, payload, raw)
      |> maybe_put_usage(payload)

    {:done, session, update, payload}
  end

  defp normalize_stream_event(%{"type" => "result"} = payload, raw, metadata, session) do
    session = update_session_from_payload(session, payload)

    update =
      session
      |> base_update(metadata, result_error_event(payload), payload, raw)
      |> maybe_put_usage(payload)

    {:error, {:claude_turn_failed, payload}, update}
  end

  defp normalize_stream_event(payload, raw, metadata, session) do
    session = update_session_from_payload(session, payload)
    update = base_update(session, metadata, :notification, payload, raw)
    {:continue, session, update}
  end

  defp result_error_event(%{"permission_denials" => denials}) when is_list(denials) and denials != [],
    do: :permission_denied

  defp result_error_event(_payload), do: :turn_failed

  defp assistant_event(%{"message" => %{"content" => contents}}) when is_list(contents) do
    if Enum.any?(contents, &(is_map(&1) and Map.get(&1, "type") == "tool_use")) do
      :tool_use_requested
    else
      :assistant_message
    end
  end

  defp assistant_event(_payload), do: :assistant_message

  defp base_update(session, metadata, event, payload, raw) do
    %{
      agent_kind: "claude",
      event: event,
      payload: payload,
      raw: raw,
      timestamp: DateTime.utc_now(),
      resume_id: session.resume_id,
      session_id: session.session_id,
      executor_pid: metadata[:executor_pid]
    }
  end

  defp maybe_put_usage(update, payload) when is_map(update) and is_map(payload) do
    case normalize_usage(payload) do
      nil -> update
      usage -> Map.put(update, :usage, usage)
    end
  end

  defp normalize_usage(%{"usage" => usage}) when is_map(usage), do: normalize_usage_map(usage)
  defp normalize_usage(%{"message" => %{"usage" => usage}}) when is_map(usage), do: normalize_usage_map(usage)
  defp normalize_usage(_payload), do: nil

  defp normalize_usage_map(usage) when is_map(usage) do
    input_tokens =
      integer_value(usage, "input_tokens", "inputTokens") +
        integer_value(usage, "cache_creation_input_tokens", "cacheCreationInputTokens") +
        integer_value(usage, "cache_read_input_tokens", "cacheReadInputTokens")

    output_tokens = integer_value(usage, "output_tokens", "outputTokens")

    if input_tokens > 0 or output_tokens > 0 do
      %{
        input_tokens: input_tokens,
        output_tokens: output_tokens,
        total_tokens: input_tokens + output_tokens
      }
    end
  end

  defp normalize_usage_map(_usage), do: nil

  defp update_session_from_payload(session, payload) when is_map(session) and is_map(payload) do
    session_id =
      Map.get(payload, "session_id") ||
        get_in(payload, ["message", "session_id"]) ||
        Map.get(session, :session_id)

    resume_id = session_id || Map.get(session, :resume_id)

    %{session | session_id: session_id, resume_id: resume_id}
  end

  defp emit_update(on_message, update) when is_function(on_message, 1), do: on_message.(update)

  defp next_timeout_ms(session, started_at_ms, last_output_at_ms) do
    now_ms = System.monotonic_time(:millisecond)
    turn_remaining = max(0, session.turn_timeout_ms - (now_ms - started_at_ms))

    stall_remaining =
      case session.stall_timeout_ms do
        timeout when is_integer(timeout) and timeout > 0 -> max(0, timeout - (now_ms - last_output_at_ms))
        _ -> turn_remaining
      end

    min_positive(turn_remaining, stall_remaining)
  end

  defp timeout_reason(turn_timeout_ms, stall_timeout_ms, started_at_ms, last_output_at_ms) do
    now_ms = System.monotonic_time(:millisecond)

    cond do
      is_integer(stall_timeout_ms) and stall_timeout_ms > 0 and now_ms - last_output_at_ms >= stall_timeout_ms ->
        :stall_timeout

      is_integer(turn_timeout_ms) and now_ms - started_at_ms >= turn_timeout_ms ->
        :turn_timeout

      true ->
        :turn_timeout
    end
  end

  defp min_positive(left, right) when left <= 0, do: max(1, right)
  defp min_positive(left, right) when right <= 0, do: max(1, left)
  defp min_positive(left, right), do: min(left, right)

  defp integer_value(usage, snake_key, camel_key) when is_map(usage) do
    case Map.get(usage, snake_key) || Map.get(usage, camel_key) do
      value when is_integer(value) -> value
      _ -> 0
    end
  end

  defp port_metadata(port, worker_host) when is_port(port) do
    base_metadata =
      case :erlang.port_info(port, :os_pid) do
        {:os_pid, os_pid} -> %{executor_pid: Integer.to_string(os_pid)}
        _ -> %{}
      end

    case worker_host do
      host when is_binary(host) -> Map.put(base_metadata, :worker_host, host)
      _ -> base_metadata
    end
  end

  defp stop_port(port) when is_port(port) do
    Port.close(port)
    :ok
  catch
    :error, _reason -> :ok
  end

  defp stop_port(_port), do: :ok

  defp send_port_command(port, data) when is_port(port) and is_binary(data) do
    Port.command(port, data)
  catch
    :error, _reason -> false
  end

  defp send_port_command(_port, _data), do: false

  defp default_on_message(_update), do: :ok
end
