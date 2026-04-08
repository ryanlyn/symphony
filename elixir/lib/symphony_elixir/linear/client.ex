defmodule SymphonyElixir.Linear.Client do
  @moduledoc """
  Thin Linear GraphQL client for polling candidate issues.
  """

  require Logger
  alias SymphonyElixir.{Config, Linear.Issue}

  @issue_page_size 50
  @max_error_body_log_bytes 1_000
  @rate_limit_base_delay_ms 1_000
  @rate_limit_max_delay_ms 30_000
  @rate_limit_max_retries 4
  @retry_after_http_date_regex ~r/^[A-Za-z]{3}, (?<day>\d{2}) (?<month>[A-Za-z]{3}) (?<year>\d{4}) (?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2}) GMT$/
  @retry_after_http_months %{
    "Jan" => 1,
    "Feb" => 2,
    "Mar" => 3,
    "Apr" => 4,
    "May" => 5,
    "Jun" => 6,
    "Jul" => 7,
    "Aug" => 8,
    "Sep" => 9,
    "Oct" => 10,
    "Nov" => 11,
    "Dec" => 12
  }

  @query """
  query SymphonyLinearPoll($projectSlug: String!, $stateNames: [String!]!, $first: Int!, $relationFirst: Int!, $after: String) {
    issues(filter: {project: {slugId: {eq: $projectSlug}}, state: {name: {in: $stateNames}}}, first: $first, after: $after) {
      nodes {
        id
        identifier
        title
        description
        priority
        state {
          name
          type
        }
        branchName
        url
        assignee {
          id
        }
        labels {
          nodes {
            name
          }
        }
        inverseRelations(first: $relationFirst) {
          nodes {
            type
            issue {
              id
              identifier
              state {
                name
              }
            }
          }
        }
        createdAt
        updatedAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
  """

  @query_by_ids """
  query SymphonyLinearIssuesById($ids: [ID!]!, $first: Int!, $relationFirst: Int!) {
    issues(filter: {id: {in: $ids}}, first: $first) {
      nodes {
        id
        identifier
        title
        description
        priority
        state {
          name
          type
        }
        branchName
        url
        assignee {
          id
        }
        labels {
          nodes {
            name
          }
        }
        inverseRelations(first: $relationFirst) {
          nodes {
            type
            issue {
              id
              identifier
              state {
                name
              }
            }
          }
        }
        createdAt
        updatedAt
      }
    }
  }
  """

  @viewer_query """
  query SymphonyLinearViewer {
    viewer {
      id
    }
  }
  """

  @spec fetch_candidate_issues() :: {:ok, [Issue.t()]} | {:error, term()}
  def fetch_candidate_issues do
    tracker = Config.settings!().tracker
    project_slug = tracker.project_slug

    cond do
      is_nil(tracker.api_key) ->
        {:error, :missing_linear_api_token}

      is_nil(project_slug) ->
        {:error, :missing_linear_project_slug}

      true ->
        with {:ok, assignee_filter} <- routing_assignee_filter() do
          do_fetch_by_states(project_slug, tracker.active_states, assignee_filter)
        end
    end
  end

  @spec fetch_issues_by_states([String.t()]) :: {:ok, [Issue.t()]} | {:error, term()}
  def fetch_issues_by_states(state_names) when is_list(state_names) do
    normalized_states = Enum.map(state_names, &to_string/1) |> Enum.uniq()

    if normalized_states == [] do
      {:ok, []}
    else
      tracker = Config.settings!().tracker
      project_slug = tracker.project_slug

      cond do
        is_nil(tracker.api_key) ->
          {:error, :missing_linear_api_token}

        is_nil(project_slug) ->
          {:error, :missing_linear_project_slug}

        true ->
          do_fetch_by_states(project_slug, normalized_states, nil)
      end
    end
  end

  @spec fetch_issue_states_by_ids([String.t()]) :: {:ok, [Issue.t()]} | {:error, term()}
  def fetch_issue_states_by_ids(issue_ids) when is_list(issue_ids) do
    ids = Enum.uniq(issue_ids)

    case ids do
      [] ->
        {:ok, []}

      ids ->
        with {:ok, assignee_filter} <- routing_assignee_filter() do
          do_fetch_issue_states(ids, assignee_filter)
        end
    end
  end

  @spec graphql(String.t(), map(), keyword()) :: {:ok, map()} | {:error, term()}
  def graphql(query, variables \\ %{}, opts \\ [])
      when is_binary(query) and is_map(variables) and is_list(opts) do
    payload = build_graphql_payload(query, variables, Keyword.get(opts, :operation_name))
    request_fun = Keyword.get(opts, :request_fun, &post_graphql_request/2)
    sleep_fun = Keyword.get(opts, :sleep_fun, &Process.sleep/1)
    now_fun = Keyword.get(opts, :now_fun, &DateTime.utc_now/0)

    retry_opts = %{
      base_delay_ms: Keyword.get(opts, :rate_limit_base_delay_ms, @rate_limit_base_delay_ms),
      max_delay_ms: Keyword.get(opts, :rate_limit_max_delay_ms, @rate_limit_max_delay_ms),
      max_retries: Keyword.get(opts, :rate_limit_max_retries, @rate_limit_max_retries),
      now_fun: now_fun,
      request_fun: request_fun,
      sleep_fun: sleep_fun
    }

    with {:ok, headers} <- graphql_headers() do
      graphql_with_retry(payload, headers, retry_opts, 0)
    end
  end

  if Mix.env() == :test do
    @doc false
    @spec normalize_issue_for_test(map()) :: Issue.t() | nil
    def normalize_issue_for_test(issue) when is_map(issue) do
      normalize_issue(issue, nil)
    end

    @doc false
    @spec normalize_issue_for_test(map(), String.t() | nil) :: Issue.t() | nil
    def normalize_issue_for_test(issue, assignee) when is_map(issue) do
      assignee_filter =
        case assignee do
          value when is_binary(value) ->
            case build_assignee_filter(value) do
              {:ok, filter} -> filter
              {:error, _reason} -> nil
            end

          _ ->
            nil
        end

      normalize_issue(issue, assignee_filter)
    end

    @doc false
    @spec next_page_cursor_for_test(map()) :: {:ok, String.t()} | :done | {:error, term()}
    def next_page_cursor_for_test(page_info) when is_map(page_info), do: next_page_cursor(page_info)

    @doc false
    @spec merge_issue_pages_for_test([[Issue.t()]]) :: [Issue.t()]
    def merge_issue_pages_for_test(issue_pages) when is_list(issue_pages) do
      issue_pages
      |> Enum.reduce([], &prepend_page_issues/2)
      |> finalize_paginated_issues()
    end

    @doc false
    @spec fetch_issue_states_by_ids_for_test(
            [String.t()],
            (String.t(), map() -> {:ok, map()} | {:error, term()})
          ) ::
            {:ok, [Issue.t()]} | {:error, term()}
    def fetch_issue_states_by_ids_for_test(issue_ids, graphql_fun)
        when is_list(issue_ids) and is_function(graphql_fun, 2) do
      ids = Enum.uniq(issue_ids)

      case ids do
        [] ->
          {:ok, []}

        ids ->
          do_fetch_issue_states(ids, nil, graphql_fun)
      end
    end
  end

  defp do_fetch_by_states(project_slug, state_names, assignee_filter) do
    do_fetch_by_states_page(project_slug, state_names, assignee_filter, nil, [])
  end

  defp do_fetch_by_states_page(project_slug, state_names, assignee_filter, after_cursor, acc_issues) do
    with {:ok, body} <-
           graphql(@query, %{
             projectSlug: project_slug,
             stateNames: state_names,
             first: @issue_page_size,
             relationFirst: @issue_page_size,
             after: after_cursor
           }),
         {:ok, issues, page_info} <- decode_linear_page_response(body, assignee_filter) do
      updated_acc = prepend_page_issues(issues, acc_issues)

      case next_page_cursor(page_info) do
        {:ok, next_cursor} ->
          do_fetch_by_states_page(project_slug, state_names, assignee_filter, next_cursor, updated_acc)

        :done ->
          {:ok, finalize_paginated_issues(updated_acc)}

        {:error, reason} ->
          {:error, reason}
      end
    end
  end

  defp prepend_page_issues(issues, acc_issues) when is_list(issues) and is_list(acc_issues) do
    Enum.reverse(issues, acc_issues)
  end

  defp finalize_paginated_issues(acc_issues) when is_list(acc_issues), do: Enum.reverse(acc_issues)

  defp do_fetch_issue_states(ids, assignee_filter) do
    do_fetch_issue_states(ids, assignee_filter, &graphql/2)
  end

  defp do_fetch_issue_states(ids, assignee_filter, graphql_fun)
       when is_list(ids) and is_function(graphql_fun, 2) do
    issue_order_index = issue_order_index(ids)
    do_fetch_issue_states_page(ids, assignee_filter, graphql_fun, [], issue_order_index)
  end

  defp do_fetch_issue_states_page([], _assignee_filter, _graphql_fun, acc_issues, issue_order_index) do
    acc_issues
    |> finalize_paginated_issues()
    |> sort_issues_by_requested_ids(issue_order_index)
    |> then(&{:ok, &1})
  end

  defp do_fetch_issue_states_page(ids, assignee_filter, graphql_fun, acc_issues, issue_order_index) do
    {batch_ids, rest_ids} = Enum.split(ids, @issue_page_size)

    case graphql_fun.(@query_by_ids, %{
           ids: batch_ids,
           first: length(batch_ids),
           relationFirst: @issue_page_size
         }) do
      {:ok, body} ->
        with {:ok, issues} <- decode_linear_response(body, assignee_filter) do
          updated_acc = prepend_page_issues(issues, acc_issues)
          do_fetch_issue_states_page(rest_ids, assignee_filter, graphql_fun, updated_acc, issue_order_index)
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp issue_order_index(ids) when is_list(ids) do
    ids
    |> Enum.with_index()
    |> Map.new()
  end

  defp sort_issues_by_requested_ids(issues, issue_order_index)
       when is_list(issues) and is_map(issue_order_index) do
    fallback_index = map_size(issue_order_index)

    Enum.sort_by(issues, fn
      %Issue{id: issue_id} -> Map.get(issue_order_index, issue_id, fallback_index)
      _ -> fallback_index
    end)
  end

  defp build_graphql_payload(query, variables, operation_name) do
    %{
      "query" => query,
      "variables" => variables
    }
    |> maybe_put_operation_name(operation_name)
  end

  defp maybe_put_operation_name(payload, operation_name) when is_binary(operation_name) do
    trimmed = String.trim(operation_name)

    if trimmed == "" do
      payload
    else
      Map.put(payload, "operationName", trimmed)
    end
  end

  defp maybe_put_operation_name(payload, _operation_name), do: payload

  defp graphql_with_retry(payload, headers, retry_opts, retry_count) do
    case retry_opts.request_fun.(payload, headers) do
      {:ok, %{status: 200, body: body}} ->
        {:ok, body}

      {:ok, response} ->
        maybe_retry_rate_limited_response(payload, headers, retry_opts, retry_count, response)

      {:error, reason} ->
        Logger.error("Linear GraphQL request failed: #{inspect(reason)}")
        {:error, {:linear_api_request, reason}}
    end
  end

  defp maybe_retry_rate_limited_response(payload, headers, retry_opts, retry_count, %{status: 429} = response) do
    if retry_count < retry_opts.max_retries do
      delay_ms = retry_delay_ms(response, retry_opts, retry_count)

      Logger.warning(
        "Linear GraphQL request rate limited status=429 retry=#{retry_count + 1}/#{retry_opts.max_retries}" <>
          " delay_ms=#{delay_ms}" <> linear_error_context(payload, response)
      )

      retry_opts.sleep_fun.(delay_ms)
      graphql_with_retry(payload, headers, retry_opts, retry_count + 1)
    else
      log_graphql_status_error(payload, response)
      {:error, {:linear_api_status, response.status}}
    end
  end

  defp maybe_retry_rate_limited_response(payload, _headers, _retry_opts, _retry_count, response) do
    log_graphql_status_error(payload, response)
    {:error, {:linear_api_status, response.status}}
  end

  defp retry_delay_ms(response, retry_opts, retry_count) do
    response
    |> retry_after_header_value()
    |> parse_retry_after_ms(retry_opts.now_fun)
    |> case do
      delay_ms when is_integer(delay_ms) and delay_ms >= 0 ->
        delay_ms

      _ ->
        exponential_retry_delay_ms(retry_opts.base_delay_ms, retry_opts.max_delay_ms, retry_count)
    end
  end

  defp exponential_retry_delay_ms(base_delay_ms, max_delay_ms, retry_count)
       when is_integer(base_delay_ms) and base_delay_ms > 0 and is_integer(max_delay_ms) and max_delay_ms > 0 and
              is_integer(retry_count) and retry_count >= 0 do
    min(base_delay_ms * Integer.pow(2, retry_count), max_delay_ms)
  end

  defp exponential_retry_delay_ms(_base_delay_ms, max_delay_ms, _retry_count)
       when is_integer(max_delay_ms) and max_delay_ms > 0,
       do: max_delay_ms

  defp exponential_retry_delay_ms(_base_delay_ms, _max_delay_ms, _retry_count), do: @rate_limit_base_delay_ms

  defp retry_after_header_value(%{headers: headers}), do: retry_after_header_value(headers)

  defp retry_after_header_value(headers) when is_map(headers) do
    Enum.find_value(headers, fn
      {key, value} ->
        if String.downcase(to_string(key)) == "retry-after" do
          normalize_header_value(value)
        end

      _ ->
        nil
    end)
  end

  defp retry_after_header_value(headers) when is_list(headers) do
    Enum.find_value(headers, fn
      {key, value} ->
        if String.downcase(to_string(key)) == "retry-after" do
          normalize_header_value(value)
        end

      _ ->
        nil
    end)
  end

  defp retry_after_header_value(_headers), do: nil

  defp normalize_header_value([value | _rest]), do: normalize_header_value(value)
  defp normalize_header_value(value) when is_binary(value), do: String.trim(value)
  defp normalize_header_value(value) when is_list(value), do: value |> to_string() |> String.trim()
  defp normalize_header_value(_value), do: nil

  defp parse_retry_after_ms(nil, _now_fun), do: nil

  defp parse_retry_after_ms(retry_after, now_fun) when is_binary(retry_after) do
    case Integer.parse(retry_after) do
      {seconds, ""} when seconds >= 0 ->
        seconds * 1_000

      _ ->
        parse_retry_after_http_date_ms(retry_after, now_fun)
    end
  end

  defp parse_retry_after_ms(_retry_after, _now_fun), do: nil

  defp parse_retry_after_http_date_ms(retry_after, now_fun) when is_binary(retry_after) do
    with %{} = captures <- Regex.named_captures(@retry_after_http_date_regex, retry_after),
         {:ok, month} <- retry_after_http_month(captures["month"]),
         {year, ""} <- Integer.parse(captures["year"]),
         {day, ""} <- Integer.parse(captures["day"]),
         {hour, ""} <- Integer.parse(captures["hour"]),
         {minute, ""} <- Integer.parse(captures["minute"]),
         {second, ""} <- Integer.parse(captures["second"]),
         {:ok, naive_dt} <- NaiveDateTime.new(year, month, day, hour, minute, second),
         {:ok, retry_after_dt} <- DateTime.from_naive(naive_dt, "Etc/UTC") do
      max(DateTime.diff(retry_after_dt, now_fun.(), :millisecond), 0)
    else
      _ ->
        nil
    end
  end

  defp retry_after_http_month(month_abbrev) when is_binary(month_abbrev) do
    case Map.fetch(@retry_after_http_months, month_abbrev) do
      {:ok, month} -> {:ok, month}
      :error -> :error
    end
  end

  defp log_graphql_status_error(payload, response) do
    Logger.error("Linear GraphQL request failed status=#{response.status}" <> linear_error_context(payload, response))
  end

  defp linear_error_context(payload, response) when is_map(payload) do
    operation_name =
      case Map.get(payload, "operationName") do
        name when is_binary(name) and name != "" -> " operation=#{name}"
        _ -> ""
      end

    body =
      response
      |> Map.get(:body)
      |> summarize_error_body()

    operation_name <> " body=" <> body
  end

  defp summarize_error_body(body) when is_binary(body) do
    body
    |> String.replace(~r/\s+/, " ")
    |> String.trim()
    |> truncate_error_body()
    |> inspect()
  end

  defp summarize_error_body(body) do
    body
    |> inspect(limit: 20, printable_limit: @max_error_body_log_bytes)
    |> truncate_error_body()
  end

  defp truncate_error_body(body) when is_binary(body) do
    if byte_size(body) > @max_error_body_log_bytes do
      binary_part(body, 0, @max_error_body_log_bytes) <> "...<truncated>"
    else
      body
    end
  end

  defp graphql_headers do
    case Config.settings!().tracker.api_key do
      nil ->
        {:error, :missing_linear_api_token}

      token ->
        {:ok,
         [
           {"Authorization", token},
           {"Content-Type", "application/json"}
         ]}
    end
  end

  defp post_graphql_request(payload, headers) do
    Req.post(Config.settings!().tracker.endpoint,
      headers: headers,
      json: payload,
      connect_options: [timeout: 30_000]
    )
  end

  defp decode_linear_response(%{"data" => %{"issues" => %{"nodes" => nodes}}}, assignee_filter) do
    issues =
      nodes
      |> Enum.map(&normalize_issue(&1, assignee_filter))
      |> Enum.reject(&is_nil/1)

    {:ok, issues}
  end

  defp decode_linear_response(%{"errors" => errors}, _assignee_filter) do
    {:error, {:linear_graphql_errors, errors}}
  end

  defp decode_linear_response(_unknown, _assignee_filter) do
    {:error, :linear_unknown_payload}
  end

  defp decode_linear_page_response(
         %{
           "data" => %{
             "issues" => %{
               "nodes" => nodes,
               "pageInfo" => %{"hasNextPage" => has_next_page, "endCursor" => end_cursor}
             }
           }
         },
         assignee_filter
       ) do
    with {:ok, issues} <- decode_linear_response(%{"data" => %{"issues" => %{"nodes" => nodes}}}, assignee_filter) do
      {:ok, issues, %{has_next_page: has_next_page == true, end_cursor: end_cursor}}
    end
  end

  defp decode_linear_page_response(response, assignee_filter), do: decode_linear_response(response, assignee_filter)

  defp next_page_cursor(%{has_next_page: true, end_cursor: end_cursor})
       when is_binary(end_cursor) and byte_size(end_cursor) > 0 do
    {:ok, end_cursor}
  end

  defp next_page_cursor(%{has_next_page: true}), do: {:error, :linear_missing_end_cursor}
  defp next_page_cursor(_), do: :done

  defp normalize_issue(issue, assignee_filter) when is_map(issue) do
    assignee = issue["assignee"]

    %Issue{
      id: issue["id"],
      identifier: issue["identifier"],
      title: issue["title"],
      description: issue["description"],
      priority: parse_priority(issue["priority"]),
      state: get_in(issue, ["state", "name"]),
      state_type: get_in(issue, ["state", "type"]),
      branch_name: issue["branchName"],
      url: issue["url"],
      assignee_id: assignee_field(assignee, "id"),
      blocked_by: extract_blockers(issue),
      labels: extract_labels(issue),
      assigned_to_worker: assigned_to_worker?(assignee, assignee_filter),
      created_at: parse_datetime(issue["createdAt"]),
      updated_at: parse_datetime(issue["updatedAt"])
    }
  end

  defp normalize_issue(_issue, _assignee_filter), do: nil

  defp assignee_field(%{} = assignee, field) when is_binary(field), do: assignee[field]
  defp assignee_field(_assignee, _field), do: nil

  defp assigned_to_worker?(_assignee, nil), do: true

  defp assigned_to_worker?(%{} = assignee, %{match_values: match_values})
       when is_struct(match_values, MapSet) do
    assignee
    |> assignee_id()
    |> then(fn
      nil -> false
      assignee_id -> MapSet.member?(match_values, assignee_id)
    end)
  end

  defp assigned_to_worker?(_assignee, _assignee_filter), do: false

  defp assignee_id(%{} = assignee), do: normalize_assignee_match_value(assignee["id"])

  defp routing_assignee_filter do
    case Config.settings!().tracker.assignee do
      nil ->
        {:ok, nil}

      assignee ->
        build_assignee_filter(assignee)
    end
  end

  defp build_assignee_filter(assignee) when is_binary(assignee) do
    case normalize_assignee_match_value(assignee) do
      nil ->
        {:ok, nil}

      "me" ->
        resolve_viewer_assignee_filter()

      normalized ->
        {:ok, %{configured_assignee: assignee, match_values: MapSet.new([normalized])}}
    end
  end

  defp resolve_viewer_assignee_filter do
    case graphql(@viewer_query, %{}) do
      {:ok, %{"data" => %{"viewer" => viewer}}} when is_map(viewer) ->
        case assignee_id(viewer) do
          nil ->
            {:error, :missing_linear_viewer_identity}

          viewer_id ->
            {:ok, %{configured_assignee: "me", match_values: MapSet.new([viewer_id])}}
        end

      {:ok, _body} ->
        {:error, :missing_linear_viewer_identity}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp normalize_assignee_match_value(value) when is_binary(value) do
    case value |> String.trim() do
      "" -> nil
      normalized -> normalized
    end
  end

  defp normalize_assignee_match_value(_value), do: nil

  defp extract_labels(%{"labels" => %{"nodes" => labels}}) when is_list(labels) do
    labels
    |> Enum.map(& &1["name"])
    |> Enum.reject(&is_nil/1)
    |> Enum.map(&String.downcase/1)
  end

  defp extract_labels(_), do: []

  defp extract_blockers(%{"inverseRelations" => %{"nodes" => inverse_relations}})
       when is_list(inverse_relations) do
    inverse_relations
    |> Enum.flat_map(fn
      %{"type" => relation_type, "issue" => blocker_issue}
      when is_binary(relation_type) and is_map(blocker_issue) ->
        if String.downcase(String.trim(relation_type)) == "blocks" do
          [
            %{
              id: blocker_issue["id"],
              identifier: blocker_issue["identifier"],
              state: get_in(blocker_issue, ["state", "name"])
            }
          ]
        else
          []
        end

      _ ->
        []
    end)
  end

  defp extract_blockers(_), do: []

  defp parse_datetime(nil), do: nil

  defp parse_datetime(raw) do
    case DateTime.from_iso8601(raw) do
      {:ok, dt, _offset} -> dt
      _ -> nil
    end
  end

  defp parse_priority(priority) when is_integer(priority), do: priority
  defp parse_priority(_priority), do: nil
end
