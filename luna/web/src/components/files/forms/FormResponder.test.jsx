import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import FormResponder from "./FormResponder.jsx";

/** @type {{ version: number, title: string, description: string, settings: Record<string, unknown>, questions: Record<string, unknown>[] }} */
const FORM = {
  version: 1,
  title: "Reunion RSVP",
  description: "",
  settings: { collecting: true, allowEdits: true, responseLimit: "unlimited" },
  questions: [
    {
      id: "q_1",
      type: "choice",
      label: "Coming?",
      required: true,
      config: { options: ["Yes", "No"] },
    },
    { id: "q_2", type: "short_text", label: "Your name" },
  ],
};

const STORE_KEY = "lunaform_responses_tok";

function seedResponses(entries) {
  localStorage.setItem(STORE_KEY, JSON.stringify(entries));
}

function storedResponses() {
  return JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
}

function renderResponder(form = FORM, entry = "/s/tok") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <FormResponder token="tok" form={form} />
    </MemoryRouter>,
  );
}

function okJson(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function lastPost(fetchMock) {
  const call = fetchMock.mock.calls.find(([, o]) => o && o.method === "POST");
  return call ? JSON.parse(call[1].body) : null;
}

async function answerFlowAndSend() {
  fireEvent.click(await screen.findByRole("button", { name: /^Start/i }));
  fireEvent.click(await screen.findByRole("button", { name: "Yes" }));
  fireEvent.click(await screen.findByRole("button", { name: /Review answers/i }));
  fireEvent.click(await screen.findByRole("button", { name: /Send answers/i }));
  await screen.findByText(/Sent — thank you/i);
}

beforeEach(() => {
  localStorage.clear();
  for (const part of document.cookie.split(";")) {
    const name = part.split("=")[0].trim();
    if (name) document.cookie = `${name}=;max-age=0;path=/`;
  }
});

describe("FormResponder", () => {
  it("edit links open every question on one page and save through the respond endpoint", async () => {
    const fetchMock = vi.fn(async (_url, options = {}) => {
      if (options.method === "POST") {
        return okJson({ ok: true, id: "r_1", edit_token: "tok-edit" });
      }
      return okJson({ ok: true, id: "r_1", answers: { q_1: "Yes", q_2: "Sam" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderResponder(FORM, "/s/tok?edit=tok-edit");

    // All questions are on one scrollable page — no stepping.
    expect(
      await screen.findByRole("heading", { name: "Change your answers" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Coming?")).toBeInTheDocument();
    expect(screen.getByText("Your name")).toBeInTheDocument();
    // Existing answers are prefilled.
    expect(screen.getByRole("button", { name: "Yes" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("Your name")).toHaveValue("Sam");

    fireEvent.click(screen.getByRole("button", { name: "No" }));
    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));

    await waitFor(() => {
      const body = lastPost(fetchMock);
      expect(body).toBeTruthy();
      expect(body.edit_token).toBe("tok-edit");
      expect(body.response_id).toBe("r_1");
      expect(body.answers.q_1).toBe("No");
      expect(body.answers.q_2).toBe("Sam");
    });
    expect(await screen.findByText(/Sent — thank you/i)).toBeInTheDocument();

    // The response joined this device's stored list with its edit secret.
    const stored = storedResponses();
    expect(stored).toHaveLength(1);
    expect(stored[0].edit_token).toBe("tok-edit");
  });

  it("blocks saving until required questions are answered", async () => {
    const requiredText = {
      ...FORM,
      questions: [
        { id: "q_1", type: "short_text", label: "Your name", required: true },
      ],
    };
    const fetchMock = vi.fn(async (_url, options = {}) => {
      if (options.method === "POST") {
        return okJson({ ok: true, id: "r_1", edit_token: "tok-edit" });
      }
      return okJson({ ok: true, id: "r_1", answers: {} });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderResponder(requiredText, "/s/tok?edit=tok-edit");

    expect(await screen.findByText("Your name")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));

    expect(await screen.findByText("This one needs an answer.")).toBeInTheDocument();
    expect(lastPost(fetchMock)).toBeNull();
  });

  it("offers Edit Response on the thank-you card when the form allows changes", async () => {
    const fetchMock = vi.fn(async (_url, options = {}) =>
      options.method === "POST"
        ? okJson({ ok: true, id: "r_2", edit_token: "fresh-tok" })
        : okJson({}),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderResponder(FORM);
    await answerFlowAndSend();

    fireEvent.click(screen.getByRole("button", { name: /Edit Response/i }));
    expect(
      await screen.findByRole("heading", { name: "Change your answers" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Coming?")).toBeInTheDocument();
    expect(screen.getByText("Your name")).toBeInTheDocument();
  });

  it("lands on the completed state, not the intro, when this device has answered", async () => {
    seedResponses([
      {
        id: "r_9",
        edit_token: "stored-tok",
        at: 1727000000000,
        answers: { q_1: "Yes", q_2: "Sam" },
      },
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => okJson({})));

    renderResponder(FORM);

    expect(
      await screen.findByText(/You've answered this form/i),
    ).toBeInTheDocument();
    // The fresh-start intro is not the landing.
    expect(screen.queryByRole("button", { name: /^Start/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Edit Response/i }));
    expect(
      await screen.findByRole("heading", { name: "Change your answers" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Yes" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("Your name")).toHaveValue("Sam");
  });

  it("lists each stored response in a picker and prefills the one picked", async () => {
    seedResponses([
      {
        id: "r_1",
        edit_token: "tok-one",
        at: 1727000000000,
        answers: { q_1: "Yes", q_2: "Sam" },
      },
      {
        id: "r_2",
        edit_token: "tok-two",
        at: 1727000060000,
        answers: { q_1: "No", q_2: "Jo" },
      },
    ]);
    const fetchMock = vi.fn(async (_url, options = {}) =>
      options.method === "POST"
        ? okJson({ ok: true, id: "r_2", edit_token: "tok-two" })
        : okJson({}),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderResponder(FORM);

    expect(
      await screen.findByText(/You've sent 2 answers/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Edit Responses/i }));

    // The picker tells the answers apart by time and a content preview.
    expect(
      await screen.findByText(/Which answer do you want to change/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Coming\?: Yes/)).toBeInTheDocument();
    expect(screen.getByText(/Coming\?: No/)).toBeInTheDocument();

    fireEvent.click(screen.getByText(/Coming\?: No/));
    expect(
      await screen.findByRole("heading", { name: "Change your answers" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "No" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("Your name")).toHaveValue("Jo");

    // Saving targets THAT response's own id and secret.
    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
    await waitFor(() => {
      const body = lastPost(fetchMock);
      expect(body).toBeTruthy();
      expect(body.edit_token).toBe("tok-two");
      expect(body.response_id).toBe("r_2");
      expect(body.answers.q_1).toBe("No");
    });
  });

  it("responds again as a new response, not an edit of the old one", async () => {
    seedResponses([
      {
        id: "r_9",
        edit_token: "stored-tok",
        at: 1727000000000,
        answers: { q_1: "Yes", q_2: "Sam" },
      },
    ]);
    const fetchMock = vi.fn(async (_url, options = {}) =>
      options.method === "POST"
        ? okJson({ ok: true, id: "r_10", edit_token: "brand-new-tok" })
        : okJson({}),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderResponder(FORM);

    fireEvent.click(
      await screen.findByRole("button", { name: /Respond again/i }),
    );
    // Fresh intro → blank answers.
    fireEvent.click(await screen.findByRole("button", { name: /^Start/i }));
    fireEvent.click(await screen.findByRole("button", { name: "No" }));
    fireEvent.click(await screen.findByRole("button", { name: /Review answers/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Send answers/i }));

    await waitFor(() => {
      const body = lastPost(fetchMock);
      expect(body).toBeTruthy();
      expect("response_id" in body).toBe(false);
      expect(body.edit_token).not.toBe("stored-tok");
      expect(body.answers.q_1).toBe("No");
    });

    // Both responses are kept on this device.
    expect(storedResponses()).toHaveLength(2);
  });

  it("hides Respond again when the form takes one answer per person", async () => {
    const oneOnly = {
      ...FORM,
      settings: { ...FORM.settings, responseLimit: "one" },
    };
    seedResponses([
      {
        id: "r_9",
        edit_token: "stored-tok",
        at: 1727000000000,
        answers: { q_1: "Yes" },
      },
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => okJson({})));

    renderResponder(oneOnly);

    expect(
      await screen.findByText(/one answer per person/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Respond again/i })).toBeNull();
    // Editing is still offered.
    expect(
      screen.getByRole("button", { name: /Edit Response/i }),
    ).toBeInTheDocument();
  });

  it("never sends edit material when the form disallows changes", async () => {
    const noEdits = {
      ...FORM,
      settings: { ...FORM.settings, allowEdits: false },
    };
    const fetchMock = vi.fn(async (_url, options = {}) =>
      options.method === "POST"
        ? okJson({ ok: true, id: "r_3", edit_token: null })
        : okJson({}),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderResponder(noEdits);
    await answerFlowAndSend();

    await waitFor(() => {
      const body = lastPost(fetchMock);
      expect(body).toBeTruthy();
      expect("edit_token" in body).toBe(false);
      expect("response_id" in body).toBe(false);
    });

    // No edit link and no way back into an edit view.
    expect(screen.queryByRole("button", { name: /Edit Response/i })).toBeNull();
    expect(screen.queryByText(/Keep this link/i)).toBeNull();
    // The stored record carries no edit secret either.
    const stored = storedResponses();
    expect(stored).toHaveLength(1);
    expect("edit_token" in stored[0]).toBe(false);
  });

  it("lands on the intro with a notice when an edit link fails", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: "This form doesn't let you change answers after you send them.",
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderResponder(FORM, "/s/tok?edit=stale-tok");

    expect(
      await screen.findByText(/doesn't let you change answers/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Start/i })).toBeInTheDocument();
  });
});
