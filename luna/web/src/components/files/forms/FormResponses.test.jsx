import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import FormResponses from "./FormResponses.jsx";
import { FileSourceProvider, driveSource, shareSource } from "../../../lib/fileSource.jsx";

const QUESTIONS = [
  {
    id: "q_c",
    type: "choice",
    label: "Coming?",
    config: { options: ["Yes", "No"] },
  },
  { id: "q_n", type: "number", label: "Guests" },
  { id: "q_t", type: "short_text", label: "Name" },
];

const SUMMARY = {
  total: 4,
  questions: [
    {
      id: "q_c",
      answered: 4,
      values: [{ value: "Yes", count: 3 }, { value: "No", count: 1 }],
    },
    {
      id: "q_n",
      answered: 4,
      values: [{ value: 10, count: 2 }, { value: "15", count: 2 }],
    },
    // Text values stay out of the card; the count is all the card shows.
    { id: "q_t", answered: 4, values: [{ value: "A long answer nobody should see here", count: 1 }] },
  ],
};

const RESPONSES = [
  { id: "r1", at: 1727000000, answers: { q_c: "Yes", q_n: 10, q_t: "Ada" } },
];

function renderResponses(props = {}) {
  return render(
    <ToastProvider>
      <FormResponses
        driveId="d1"
        formPath="forms/rsvp.lunaform"
        questions={QUESTIONS}
        responses={RESPONSES}
        total={1}
        offset={0}
        pageSize={100}
        nextOffset={null}
        summary={SUMMARY}
        {...props}
      />
    </ToastProvider>,
  );
}

describe("FormResponses", () => {
  it("pages through responses and shows the range out of the full total", () => {
    const onPageChange = vi.fn();
    renderResponses({
      total: 250,
      offset: 0,
      nextOffset: 100,
      onPageChange,
    });

    expect(screen.getByText("250 responses")).toBeInTheDocument();
    expect(screen.getByText("Showing 1–1 of 250")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Previous page/ })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /Next page/ }));
    expect(onPageChange).toHaveBeenCalledWith(100);

    cleanup();
    onPageChange.mockClear();
    renderResponses({
      total: 250,
      offset: 100,
      nextOffset: 200,
      onPageChange,
    });
    fireEvent.click(screen.getByRole("button", { name: /Previous page/ }));
    expect(onPageChange).toHaveBeenCalledWith(0);
  });

  it("renders choice bars, number totals, and text counts from the summary", () => {
    renderResponses();

    expect(screen.getByText("3 · 75%")).toBeInTheDocument();
    expect(screen.getByText("1 · 25%")).toBeInTheDocument();
    expect(screen.getByText("Total 50 · average 12.5")).toBeInTheDocument();
    expect(screen.getAllByText("4 answered")).toHaveLength(3);
    expect(screen.getByText(/Answers are in the table below/)).toBeInTheDocument();
    // Thousands of text answers would be a wall; the card keeps the count.
    expect(screen.queryByText("A long answer nobody should see here")).toBeNull();
  });

  it("downloads CSV through the server route as a link", () => {
    renderResponses({ total: 3 });

    const link = screen.getByRole("link", { name: /Download CSV/ });
    expect(link).toHaveAttribute(
      "href",
      "/api/v1/forms/export?drive_id=d1&path=forms%2Frsvp.lunaform&format=csv",
    );
    expect(link).toHaveAttribute("download", "rsvp-responses.csv");
  });

  it("keeps the download disabled when there are no responses", () => {
    renderResponses({ responses: [], total: 0, summary: { total: 0, questions: [] } });

    expect(screen.getByText("No responses yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Download CSV/ })).toBeDisabled();
  });

  it("uses the link-scoped export route for a guest", () => {
    const source = shareSource({ token: "tok", kind: "folder", caps: "full" });
    render(
      <ToastProvider>
        <FileSourceProvider source={source}>
          <FormResponses
            driveId="ignored"
            formPath="rsvp.lunaform"
            questions={QUESTIONS}
            responses={RESPONSES}
            total={9}
            offset={0}
            pageSize={1}
            nextOffset={1}
            summary={SUMMARY}
          />
        </FileSourceProvider>
      </ToastProvider>,
    );

    expect(screen.getByRole("link", { name: /Download CSV/ })).toHaveAttribute(
      "href",
      "/s/tok/export?path=rsvp.lunaform&format=csv",
    );
  });

  it("falls back to the loaded page when a source has no export route", () => {
    const source = { ...driveSource, formExportUrl: undefined };
    render(
      <ToastProvider>
        <FileSourceProvider source={source}>
          <FormResponses
            driveId="d1"
            formPath="rsvp.lunaform"
            questions={QUESTIONS}
            responses={RESPONSES}
            total={9}
            offset={0}
            pageSize={1}
            nextOffset={1}
            summary={SUMMARY}
          />
        </FileSourceProvider>
      </ToastProvider>,
    );

    // Honest about only having one page in the browser.
    expect(screen.getByRole("button", { name: /Download this page \(CSV\)/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Download CSV/ })).toBeNull();
  });
});
