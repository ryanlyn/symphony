defmodule SymphonyElixir.PromptBuilder do
  @moduledoc """
  Builds agent prompts from Linear issue data.
  """

  alias SymphonyElixir.Workflow

  @render_opts [strict_variables: true, strict_filters: true]

  @spec build_prompt(SymphonyElixir.Linear.Issue.t(), keyword()) :: String.t()
  def build_prompt(issue, opts \\ []) do
    Workflow.current()
    |> parsed_template!()
    |> Solid.render!(
      %{
        "attempt" => Keyword.get(opts, :attempt),
        "ensemble" => ensemble_context(opts),
        "issue" => issue |> Map.from_struct() |> to_solid_map()
      },
      @render_opts
    )
    |> IO.iodata_to_binary()
  end

  defp ensemble_context(opts) do
    ensemble_size = Keyword.get(opts, :ensemble_size, 1)
    slot_index = Keyword.get(opts, :slot_index, 0)

    %{
      "enabled" => ensemble_size > 1,
      "slot_index" => slot_index,
      "size" => ensemble_size
    }
  end

  defp parsed_template!({:ok, %{parsed_prompt_template: {:ok, template}}}), do: template

  defp parsed_template!({:ok, %{parsed_prompt_template: {:error, message}} = workflow}) do
    raise RuntimeError,
          "template_parse_error: #{message} template=#{inspect(Workflow.effective_prompt_template(workflow))}"
  end

  defp parsed_template!({:error, reason}) do
    raise RuntimeError, "workflow_unavailable: #{inspect(reason)}"
  end

  defp to_solid_map(map) when is_map(map) do
    Map.new(map, fn {key, value} -> {to_string(key), to_solid_value(value)} end)
  end

  defp to_solid_value(%DateTime{} = value), do: DateTime.to_iso8601(value)
  defp to_solid_value(%NaiveDateTime{} = value), do: NaiveDateTime.to_iso8601(value)
  defp to_solid_value(%Date{} = value), do: Date.to_iso8601(value)
  defp to_solid_value(%Time{} = value), do: Time.to_iso8601(value)
  defp to_solid_value(%_{} = value), do: value |> Map.from_struct() |> to_solid_map()
  defp to_solid_value(value) when is_map(value), do: to_solid_map(value)
  defp to_solid_value(value) when is_list(value), do: Enum.map(value, &to_solid_value/1)
  defp to_solid_value(value), do: value
end
