defmodule SymphonyElixir.Linear.Issue do
  @moduledoc """
  Normalized Linear issue representation used by the orchestrator.
  """

  defstruct [
    :id,
    :identifier,
    :title,
    :description,
    :priority,
    :state,
    :state_type,
    :branch_name,
    :url,
    :assignee_id,
    blocked_by: [],
    labels: [],
    assigned_to_worker: true,
    created_at: nil,
    updated_at: nil
  ]

  @type t :: %__MODULE__{
          id: String.t() | nil,
          identifier: String.t() | nil,
          title: String.t() | nil,
          description: String.t() | nil,
          priority: integer() | nil,
          state: String.t() | nil,
          state_type: String.t() | nil,
          branch_name: String.t() | nil,
          url: String.t() | nil,
          assignee_id: String.t() | nil,
          blocked_by: [map()],
          labels: [String.t()],
          assigned_to_worker: boolean(),
          created_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  @spec label_names(t()) :: [String.t()]
  def label_names(%__MODULE__{labels: labels}) do
    labels
  end

  @spec ensemble_size(t()) :: pos_integer() | nil
  def ensemble_size(%__MODULE__{labels: labels}) do
    Enum.find_value(labels, &parse_ensemble_label/1)
  end

  defp parse_ensemble_label(label) when is_binary(label) do
    case String.split(label, ":", parts: 2) do
      ["ensemble", n_str] -> parse_ensemble_size(n_str)
      _ -> nil
    end
  end

  defp parse_ensemble_label(_label), do: nil

  defp parse_ensemble_size(n_str) when is_binary(n_str) do
    case Integer.parse(n_str) do
      {n, ""} when n >= 1 -> n
      _ -> nil
    end
  end
end
