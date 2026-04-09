defmodule Mix.Tasks.Symphony.Runs do
  use Mix.Task

  alias SymphonyElixir.Config

  @shortdoc "Query live orchestrator run history from the observability API"

  @moduledoc """
  Query live orchestrator run history from a running Symphony session.

  Usage:

      mix symphony.runs
      mix symphony.runs --issue MONO-171
      mix symphony.runs --failed
      mix symphony.runs --cost
      mix symphony.runs --retries
      mix symphony.runs --id run-12

  The task talks to the local observability HTTP API exposed by the running
  Symphony session. Use `--port` or `--url` when the runtime is listening on a
  non-default address.
  """

  @switches [
    issue: :string,
    failed: :boolean,
    cost: :boolean,
    retries: :boolean,
    id: :string,
    limit: :integer,
    url: :string,
    port: :integer,
    json: :boolean,
    help: :boolean
  ]

  @aliases [h: :help]

  @impl Mix.Task
  def run(args) do
    {opts, _argv, invalid} = OptionParser.parse(args, strict: @switches, aliases: @aliases)

    cond do
      opts[:help] ->
        Mix.shell().info(@moduledoc)

      invalid != [] ->
        Mix.raise("Invalid option(s): #{inspect(invalid)}")

      true ->
        opts
        |> fetch_runs!()
        |> handle_response(opts)
    end
  end

  defp fetch_runs!(opts) do
    ensure_req_started!()
    Req.get!(runs_url(base_url(opts)), params: request_params(opts))
  end

  defp ensure_req_started! do
    case Application.ensure_all_started(:req) do
      {:ok, _started} -> :ok
      {:error, {app, reason}} -> Mix.raise("Unable to start #{app} for HTTP requests: #{inspect(reason)}")
    end
  end

  defp handle_response(%{status: 200, body: body}, opts) do
    body
    |> render_output(opts[:json] == true)
    |> Mix.shell().info()
  end

  defp handle_response(%{status: 404, body: body}, _opts) do
    Mix.raise(body["error"]["message"] || "Run not found")
  end

  defp handle_response(%{status: 503, body: body}, _opts) do
    Mix.raise(body["error"]["message"] || "Observability API unavailable")
  end

  defp handle_response(%{status: status}, _opts) do
    Mix.raise("Unexpected response status #{status}")
  end

  defp render_output(body, true), do: Jason.encode!(body, pretty: true)
  defp render_output(body, false), do: render_body(body)

  defp base_url(opts) do
    cond do
      is_binary(opts[:url]) and String.trim(opts[:url]) != "" ->
        String.trim_trailing(String.trim(opts[:url]), "/")

      is_integer(opts[:port]) and opts[:port] > 0 ->
        "http://#{Config.settings!().server.host}:#{opts[:port]}"

      is_integer(Config.server_port()) and Config.server_port() > 0 ->
        "http://#{Config.settings!().server.host}:#{Config.server_port()}"

      true ->
        Mix.raise("No observability server port configured. Pass --port/--url or set server.port in WORKFLOW.md.")
    end
  end

  defp runs_url(base_url), do: "#{base_url}/api/v1/runs"

  defp request_params(opts) do
    %{}
    |> maybe_put_param("issue", opts[:issue])
    |> maybe_put_param("failed", opts[:failed])
    |> maybe_put_param("cost", opts[:cost])
    |> maybe_put_param("retries", opts[:retries])
    |> maybe_put_param("id", opts[:id])
    |> maybe_put_param("limit", opts[:limit])
  end

  defp maybe_put_param(params, _key, nil), do: params
  defp maybe_put_param(params, _key, false), do: params
  defp maybe_put_param(params, key, value), do: Map.put(params, key, value)

  defp render_body(%{"view" => "run", "run" => run, "related_runs" => related_runs}) do
    lines = [
      "Run #{run["id"]}",
      "",
      "issue=#{run["issue_identifier"]} agent=#{run["agent_kind"]} outcome=#{run["outcome"]} attempt=#{run["retry_attempt"]}",
      "duration=#{format_duration(run["duration_ms"])} tokens=#{format_integer(run["tokens"]["total_tokens"])} turns=#{run["turn_count"]}",
      "session=#{run["session_id"] || "n/a"} resume=#{run["resume_id"] || "n/a"} worker=#{run["worker_host"] || "local"}",
      "workspace=#{run["workspace_path"] || "n/a"}",
      "last_event=#{run["last_event"] || "n/a"} at=#{run["last_event_at"] || "n/a"}",
      "failure_reason=#{run["failure_reason"] || "n/a"}",
      "log_file=#{get_in(run, ["log_hints", "symphony_log_file"]) || "n/a"}"
    ]

    related_section = render_related_runs(related_runs)

    Enum.join(lines ++ related_section, "\n")
  end

  defp render_body(%{"view" => "cost", "summary" => %{"by_agent" => by_agent, "top_runs" => top_runs}}) do
    [
      "Cost Summary",
      "",
      render_table(
        ["AGENT", "RUNS", "DONE", "INPUT", "OUTPUT", "TOTAL", "AVG/RUN", "USD"],
        Enum.map(by_agent, fn row ->
          [
            row["agent_kind"],
            format_integer(row["run_count"]),
            format_integer(row["completed_count"]),
            format_integer(row["input_tokens"]),
            format_integer(row["output_tokens"]),
            format_integer(row["total_tokens"]),
            format_float(row["average_total_tokens_per_run"]),
            format_cost(row["estimated_cost_usd"])
          ]
        end)
      ),
      "",
      "Top Runs",
      render_table(
        ["ID", "ISSUE", "AGENT", "OUTCOME", "TOKENS"],
        Enum.map(top_runs, fn run ->
          [
            run["id"],
            run["issue_identifier"],
            run["agent_kind"],
            run["outcome"],
            format_integer(get_in(run, ["tokens", "total_tokens"]))
          ]
        end)
      )
    ]
    |> Enum.join("\n")
  end

  defp render_body(%{"view" => "retries", "issues" => issues}) do
    [
      "Retry Summary",
      "",
      render_table(
        ["ISSUE", "ATTEMPTS", "LATEST", "TOKENS", "RUN ID", "FAILURE"],
        Enum.map(issues, fn issue ->
          [
            issue["issue_identifier"],
            format_integer(issue["attempts"]),
            issue["latest_outcome"],
            format_integer(issue["total_tokens"]),
            issue["latest_run_id"],
            issue["latest_failure_reason"] || "n/a"
          ]
        end)
      )
    ]
    |> Enum.join("\n")
  end

  defp render_body(%{"view" => "runs", "summary" => summary, "runs" => runs}) do
    [
      "Run History",
      "",
      "total=#{summary["total"]} running=#{summary["running"]} success=#{summary["success"]} failed=#{summary["failed"]} stalled=#{summary["stalled"]} canceled=#{summary["canceled"]}",
      "",
      render_table(
        ["ID", "ISSUE", "AGENT", "OUTCOME", "ATTEMPT", "TURNS", "TOKENS", "DURATION", "SESSION"],
        Enum.map(runs, fn run ->
          [
            run["id"],
            run["issue_identifier"],
            run["agent_kind"],
            run["outcome"],
            format_integer(run["retry_attempt"]),
            format_integer(run["turn_count"]),
            format_integer(get_in(run, ["tokens", "total_tokens"])),
            format_duration(run["duration_ms"]),
            compact(run["session_id"])
          ]
        end)
      )
    ]
    |> Enum.join("\n")
  end

  defp render_body(body) do
    Jason.encode!(body, pretty: true)
  end

  defp render_related_runs([]), do: []

  defp render_related_runs(related_runs) do
    [
      "",
      "Related runs",
      render_table(
        ["ID", "OUTCOME", "TOKENS", "STARTED"],
        Enum.map(related_runs, fn related ->
          [
            related["id"],
            related["outcome"],
            format_integer(get_in(related, ["tokens", "total_tokens"])),
            related["started_at"] || "n/a"
          ]
        end)
      )
    ]
  end

  defp render_table(headers, rows) do
    widths =
      headers
      |> Enum.with_index()
      |> Enum.map(fn {header, index} ->
        max(
          String.length(header),
          rows
          |> Enum.map(fn row -> row |> Enum.at(index, "") |> to_string() |> String.length() end)
          |> Enum.max(fn -> 0 end)
        )
      end)

    header_line = format_row(headers, widths)
    separator = widths |> Enum.map(&String.duplicate("-", &1)) |> format_row(widths)
    body = Enum.map(rows, &format_row(&1, widths))

    Enum.join([header_line, separator | body], "\n")
  end

  defp format_row(columns, widths) do
    columns
    |> Enum.with_index()
    |> Enum.map_join("  ", fn {value, index} ->
      value
      |> to_string()
      |> String.pad_trailing(Enum.at(widths, index))
    end)
  end

  defp format_integer(value) when is_integer(value), do: Integer.to_string(value)
  defp format_integer(value) when is_float(value), do: value |> round() |> Integer.to_string()
  defp format_integer(_value), do: "0"

  defp format_float(value) when is_float(value), do: :erlang.float_to_binary(value, decimals: 1)
  defp format_float(value) when is_integer(value), do: "#{value}.0"
  defp format_float(_value), do: "0.0"

  defp format_cost(nil), do: "n/a"
  defp format_cost(value) when is_float(value), do: "$" <> :erlang.float_to_binary(value, decimals: 4)
  defp format_cost(value) when is_integer(value), do: "$" <> Integer.to_string(value)
  defp format_cost(_value), do: "n/a"

  defp format_duration(nil), do: "n/a"

  defp format_duration(duration_ms) when is_integer(duration_ms) and duration_ms >= 1000 do
    seconds = div(duration_ms, 1000)
    "#{seconds}s"
  end

  defp format_duration(duration_ms) when is_integer(duration_ms), do: "#{duration_ms}ms"
  defp format_duration(_duration_ms), do: "n/a"

  defp compact(nil), do: "n/a"

  defp compact(value) when is_binary(value) do
    if String.length(value) > 14 do
      String.slice(value, 0, 6) <> "..." <> String.slice(value, -5, 5)
    else
      value
    end
  end

  defp compact(value), do: to_string(value)
end
