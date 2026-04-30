defmodule SymphonyElixir.Tracker.Dispatch do
  @moduledoc """
  Local dispatch routing based on tracker-provided issue labels.
  """

  alias SymphonyElixir.Linear.Issue

  @default_prefix "Symphony:"

  @spec eligible?(Issue.t(), term()) :: boolean()
  def eligible?(%Issue{} = issue, dispatch_settings) do
    prefix = route_label_prefix(dispatch_settings)
    has_route_label? = has_route_label?(issue, prefix)
    routes = route_names(issue, prefix)
    only_routes = only_routes(dispatch_settings)

    cond do
      routes == [] and has_route_label? ->
        false

      routes == [] ->
        accept_unrouted?(dispatch_settings)

      is_nil(only_routes) ->
        true

      only_routes == [] ->
        false

      true ->
        configured_routes = MapSet.new(only_routes)
        Enum.any?(routes, &MapSet.member?(configured_routes, &1))
    end
  end

  def eligible?(_issue, _dispatch_settings), do: false

  @spec route_names(Issue.t(), String.t() | nil) :: [String.t()]
  def route_names(%Issue{labels: labels}, prefix) when is_list(labels) do
    labels
    |> Enum.flat_map(&route_name(&1, prefix))
    |> Enum.uniq()
  end

  def route_names(_issue, _prefix), do: []

  @spec has_route_label?(Issue.t(), String.t() | nil) :: boolean()
  def has_route_label?(%Issue{labels: labels}, prefix) when is_list(labels) do
    Enum.any?(labels, &route_label?(&1, prefix))
  end

  def has_route_label?(_issue, _prefix), do: false

  defp route_name(label, prefix) when is_binary(label) do
    if route_label?(label, prefix) do
      label
      |> route_suffix(prefix)
      |> normalize_route_name()
      |> case do
        "" -> []
        route -> [route]
      end
    else
      []
    end
  end

  defp route_name(_label, _prefix), do: []

  defp route_label?(label, prefix) when is_binary(label) do
    prefix = normalize_prefix(prefix)

    if prefix == "" do
      String.trim(label) != ""
    else
      label
      |> String.downcase()
      |> String.starts_with?(String.downcase(prefix))
    end
  end

  defp route_label?(_label, _prefix), do: false

  defp route_suffix(label, prefix) do
    prefix = normalize_prefix(prefix)

    if prefix == "" do
      label
    else
      binary_part(label, byte_size(prefix), byte_size(label) - byte_size(prefix))
    end
  end

  @spec normalize_route_name(term()) :: String.t()
  def normalize_route_name(route) when is_binary(route) do
    route
    |> String.trim()
    |> String.downcase()
  end

  def normalize_route_name(_route), do: ""

  defp route_label_prefix(%{route_label_prefix: prefix}), do: normalize_prefix(prefix)
  defp route_label_prefix(_dispatch_settings), do: @default_prefix

  defp accept_unrouted?(%{accept_unrouted: accept_unrouted}) when is_boolean(accept_unrouted),
    do: accept_unrouted

  defp accept_unrouted?(_dispatch_settings), do: true

  defp only_routes(%{only_routes: routes}) when is_list(routes), do: normalize_routes(routes)
  defp only_routes(%{only_routes: nil}), do: nil
  defp only_routes(_dispatch_settings), do: nil

  defp normalize_routes(routes) when is_list(routes) do
    routes
    |> Enum.filter(&is_binary/1)
    |> Enum.map(&normalize_route_name/1)
    |> Enum.reject(&(&1 == ""))
    |> Enum.uniq()
  end

  defp normalize_prefix(prefix) when is_binary(prefix), do: String.trim(prefix)
  defp normalize_prefix(_prefix), do: @default_prefix
end
