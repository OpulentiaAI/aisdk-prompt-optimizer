import { promises as fs } from "fs";
import path from "path";

export const runtime = "nodejs";

type Pair = { question: string; answer: string; tool?: string };
type Session = { id: string; createdAt: string; pairs: Pair[] };
type Samples = { samples: Session[] };

function getSamplesPath(): string {
  return path.join(process.cwd(), "data", "samples.json");
}

function getPromptPath(): string {
  return path.join(process.cwd(), "data", "prompt.md");
}

function getStatusPath(): string {
  return path.join(process.cwd(), "data", "opt-status.json");
}

async function ensureDataDir(): Promise<void> {
  const dir = path.join(process.cwd(), "data");
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {}
}

// Removed unused stringifySession function

async function readSamples(): Promise<Samples> {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(getSamplesPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      // Handle new format
      if (Array.isArray(parsed.samples)) {
        return parsed as Samples;
      }
      // Handle legacy format
      if (Array.isArray(parsed.good) && Array.isArray(parsed.bad)) {
        return { samples: [...parsed.good, ...parsed.bad] };
      }
    }
  } catch {}
  return { samples: [] };
}

async function writePrompt(instruction: string): Promise<void> {
  await ensureDataDir();
  await fs.writeFile(getPromptPath(), instruction.trim() + "\n", "utf8");
}

async function readStatus(): Promise<{
  status: "idle" | "running" | "completed" | "error";
  startedAt?: string;
  updatedAt?: string;
  errorMessage?: string;
} | null> {
  try {
    const raw = await fs.readFile(getStatusPath(), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeStatus(status: {
  status: "idle" | "running" | "completed" | "error";
  startedAt?: string;
  updatedAt?: string;
  errorMessage?: string;
}): Promise<void> {
  await ensureDataDir();
  await fs.writeFile(getStatusPath(), JSON.stringify(status, null, 2), "utf8");
}

export async function GET() {
  try {
    // If an optimization is currently running, return that status immediately
    const current = await readStatus();
    if (current && current.status === "running") {
      return new Response(JSON.stringify(current), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (current && current.status === "error") {
      return new Response(JSON.stringify(current), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Read from complete optimization file instead of the deleted optimization.json
    const completePath = path.join(
      process.cwd(),
      "data",
      "complete-optimization.json"
    );
    const completeContent = await fs.readFile(completePath, "utf8");
    const completeData = JSON.parse(completeContent);

    // Read current prompt for instruction length
    const promptPath = path.join(process.cwd(), "data", "prompt.md");
    let instructionLength = 0;
    try {
      const promptContent = await fs.readFile(promptPath, "utf8");
      instructionLength = promptContent?.trim().length || 0;
    } catch {}

    // Extract instruction from the saved complete optimization (best-effort)
    let instructionFromResult: string | undefined =
      typeof completeData?.instruction === "string" && completeData.instruction
        ? completeData.instruction
        : (completeData?.result?.optimizedProgram?.instruction as
            | string
            | undefined);

    // Fallback to the current prompt.md contents if missing
    try {
      if (!instructionFromResult) {
        const promptContent = await fs.readFile(getPromptPath(), "utf8");
        const trimmed = promptContent?.trim();
        if (trimmed) instructionFromResult = trimmed;
      }
    } catch {}

    // Return data in the format the UI expects, with enhanced information
    const stats = {
      status: "completed" as const,
      bestScore: completeData.bestScore,
      totalRounds: completeData.totalRounds,
      converged: completeData.converged,
      optimizerType: completeData.optimizerType,
      optimizationTimeMs: completeData.optimizationTime,
      updatedAt: completeData.timestamp,
      instructionLength,
      instruction: instructionFromResult,
      // Enhanced data from complete optimization
      temperature: completeData.modelConfig?.temperature,
      demosCount:
        (Array.isArray(completeData.demos) && completeData.demos.length) ||
        (Array.isArray(completeData.result?.optimizedProgram?.demos)
          ? completeData.result.optimizedProgram.demos.length
          : 0),
      totalCalls: completeData.stats?.totalCalls,
      successRate:
        completeData.stats?.successfulDemos && completeData.stats?.totalCalls
          ? (
              (completeData.stats.successfulDemos /
                completeData.stats.totalCalls) *
              100
            ).toFixed(1) + "%"
          : null,
      usedSamples: {
        total:
          (Array.isArray(completeData.result?.optimizedProgram?.examples)
            ? completeData.result.optimizedProgram.examples.length
            : 0) || 0,
      },
    };

    return new Response(JSON.stringify(stats), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new Response(JSON.stringify({ status: "idle" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export async function POST(req: Request) {
  try {
    // Read optional settings from client
    let clientSettings: {
      auto?: "off" | "light" | "medium" | "heavy";
      maxMetricCalls?: number;
      candidateSelectionStrategy?: "pareto" | "current_best";
      reflectionMinibatchSize?: number;
      useMerge?: boolean;
      numThreads?: number;
    } | null = null;
    try {
      const body = await req.json();
      clientSettings = body?.settings || null;
    } catch {}

    // Mark status as running and kick off background optimization
    await writeStatus({
      status: "running",
      startedAt: new Date().toISOString(),
    });

    // Fire-and-forget background task
    setImmediate(() => {
      runOptimization(clientSettings).catch(async (err) => {
        console.log("❌ Optimization failed:", err);
        await writeStatus({
          status: "error",
          errorMessage: err instanceof Error ? err.message : String(err),
          updatedAt: new Date().toISOString(),
        });
      });
    });

    // Return immediately
    return new Response(JSON.stringify({ status: "started" }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

async function buildExamples(): Promise<
  Array<{
    conversationContext: string;
    expectedTurnResponse: string;
    toolsUsed?: string[];
  }>
> {
  const samples = await readSamples();
  const examples: Array<{
    conversationContext: string;
    expectedTurnResponse: string;
    toolsUsed?: string[];
  }> = [];
  for (const session of samples.samples) {
    if (session.pairs.length > 1) {
      const contextPairs = session.pairs.slice(0, -1);
      const lastPair = session.pairs[session.pairs.length - 1];
      const conversationContext = contextPairs
        .map(
          (pair, index) =>
            `Turn ${index + 1}:\nUser: ${pair.question}\nAssistant: ${
              pair.answer
            }${pair.tool ? ` [Tool: ${pair.tool}]` : ""}`
        )
        .join("\n\n");
      const expectedTurnResponse = `Turn ${contextPairs.length + 1}:\nUser: ${
        lastPair.question
      }\nAssistant: ${lastPair.answer}${
        lastPair.tool ? ` [Tool: ${lastPair.tool}]` : ""
      }`;
      const toolsUsed = session.pairs
        .filter((pair) => pair.tool)
        .map((pair) => pair.tool as string);
      examples.push({
        conversationContext: conversationContext || "New conversation",
        expectedTurnResponse,
        ...(toolsUsed.length > 0 && { toolsUsed }),
      });
    } else if (session.pairs.length === 1) {
      const pair = session.pairs[0];
      examples.push({
        conversationContext: "New conversation",
        expectedTurnResponse: `Turn 1:\nUser: ${pair.question}\nAssistant: ${
          pair.answer
        }${pair.tool ? ` [Tool: ${pair.tool}]` : ""}`,
        ...(pair.tool && { toolsUsed: [pair.tool] }),
      });
    }
  }
  return examples;
}

async function runOptimization(
  clientSettings: {
    auto?: "off" | "light" | "medium" | "heavy";
    maxMetricCalls?: number;
    candidateSelectionStrategy?: "pareto" | "current_best";
    reflectionMinibatchSize?: number;
    useMerge?: boolean;
    numThreads?: number;
  } | null
): Promise<void> {
  const examples = await buildExamples();

  console.log(`📊 Processing samples:`);
  console.log(`   Training examples: ${examples.length}`);
  console.log(
    `   Sample conversation:`,
    examples[0]?.conversationContext?.substring(0, 150) + "..."
  );

  if (examples.length === 0) {
    throw new Error("Need at least one chat session to optimize");
  }

  const resolvedEndpoint =
    process.env.OPTIMIZER_ENDPOINT || "http://localhost:8000";
  try {
    const healthUrl = `${resolvedEndpoint.replace(/\/$/, "")}/health`;
    const healthRes = await fetch(healthUrl, { method: "GET" });
    if (healthRes.ok) {
      console.log(`🩺 Python optimizer healthy at ${healthUrl}`);
    } else {
      console.log(
        `⚠️ Python optimizer responded with status ${healthRes.status} at ${healthUrl}`
      );
    }
  } catch (err) {
    console.log(
      `⚠️ Could not reach Python optimizer at ${resolvedEndpoint}. Set OPTIMIZER_ENDPOINT and ensure the service is running. Error:`,
      err
    );
  }

  const toolUsageExamples = examples.filter(
    (ex) => ex.toolsUsed && ex.toolsUsed.length > 0
  );
  const nonToolExamples = examples.filter(
    (ex) => !ex.toolsUsed || ex.toolsUsed.length === 0
  );
  console.log(`📋 Training analysis for instruction generation:`);
  console.log(`   Conversations with tools: ${toolUsageExamples.length}`);
  console.log(`   Conversations without tools: ${nonToolExamples.length}`);
  if (toolUsageExamples.length > 0) {
    const allTools = toolUsageExamples.flatMap((ex) => ex.toolsUsed || []);
    const uniqueTools = [...new Set(allTools)];
    console.log(`   Unique tools used: ${uniqueTools.join(", ")}`);
  }

  console.log("🔄 Optimizing your AI program with dspy.GEPA...");
  const resp = await fetch(`${resolvedEndpoint.replace(/\/$/, "")}/optimize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      examples,
      maxMetricCalls:
        typeof clientSettings?.maxMetricCalls === "number"
          ? clientSettings.maxMetricCalls
          : 50,
      auto: clientSettings?.auto,
      candidateSelectionStrategy: clientSettings?.candidateSelectionStrategy,
      reflectionMinibatchSize: clientSettings?.reflectionMinibatchSize,
      useMerge: clientSettings?.useMerge,
      numThreads: clientSettings?.numThreads,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Optimizer error ${resp.status}: ${text}`);
  }
  const result = await resp.json();

  console.log(`✅ Done! dspy.GEPA optimization completed`);

  const bestScore = result.bestScore !== undefined ? result.bestScore : -1;
  const instruction = (
    result as { optimizedProgram?: { instruction?: string } }
  )?.optimizedProgram?.instruction;
  console.log(`📊 GEPA result keys:`, Object.keys(result));
  if (bestScore >= 0) {
    console.log(`✨ Best score found: ${bestScore.toFixed(3)}`);
  }

  const optimizedDemos = (
    result as { optimizedProgram?: { demos?: unknown[] } }
  )?.optimizedProgram?.demos;
  const promptParts: string[] = [];
  const finalInstruction =
    instruction && instruction.trim()
      ? instruction
      : "You are an assistant. Answer questions helpfully and professionally.";
  promptParts.push(finalInstruction);
  if (optimizedDemos && optimizedDemos.length > 0) {
    const demoText = `\n\nOptimized Examples:\n${optimizedDemos
      .map((demo, i) => `Example ${i + 1}:\n${JSON.stringify(demo, null, 2)}`)
      .join("\n\n")}`;
    promptParts.push(demoText);
    console.log(`📚 Using ${optimizedDemos.length} optimized demos`);
  } else if (examples.length > 0) {
    const exampleText = `\n\nExamples:\n${examples
      .map(
        (ex, i) =>
          `Example ${i + 1}:\n${ex.conversationContext}\n→ ${
            ex.expectedTurnResponse
          }`
      )
      .join("\n\n")}`;
    promptParts.push(exampleText);
    console.log(`📚 Using ${examples.length} original training examples`);
  }
  const fullPrompt = promptParts.join("");
  await writePrompt(fullPrompt);
  console.log(
    `📝 Saved ${
      instruction ? "optimized" : "fallback"
    } instruction with examples to prompt.md`
  );

  const optimizedProgram = (
    result as {
      optimizedProgram?: {
        bestScore?: number;
        stats?: unknown;
        instruction?: string;
        demos?: unknown[];
        modelConfig?: unknown;
        optimizerType?: string;
        optimizationTime?: number;
        totalRounds?: number;
        converged?: boolean;
        examples?: unknown[];
      };
    }
  ).optimizedProgram;

  const completeOptimization = {
    version: "2.0",
    bestScore: optimizedProgram?.bestScore ?? bestScore,
    instruction: optimizedProgram?.instruction ?? instruction,
    demos: optimizedProgram?.demos ?? [],
    modelConfig: optimizedProgram?.modelConfig ?? undefined,
    optimizerType: optimizedProgram?.optimizerType ?? "GEPA",
    optimizationTime: optimizedProgram?.optimizationTime ?? undefined,
    totalRounds: optimizedProgram?.totalRounds ?? undefined,
    converged: optimizedProgram?.converged ?? undefined,
    stats: optimizedProgram?.stats ?? undefined,
    result: result,
    timestamp: new Date().toISOString(),
  };

  await fs.writeFile(
    path.join(process.cwd(), "data", "complete-optimization.json"),
    JSON.stringify(completeOptimization, null, 2),
    "utf8"
  );
  console.log("✅ GEPA optimization saved to complete-optimization.json");

  try {
    const versionsDir = path.join(process.cwd(), "data", "versions");
    await fs.mkdir(versionsDir, { recursive: true });
    const versionId = (completeOptimization.timestamp || "")
      .replace(/[:]/g, "-")
      .replace(/[.]/g, "-");
    const versionPath = path.join(versionsDir, versionId || String(Date.now()));
    await fs.mkdir(versionPath, { recursive: true });
    await fs.writeFile(path.join(versionPath, "prompt.md"), fullPrompt, "utf8");
    await fs.writeFile(
      path.join(versionPath, "complete-optimization.json"),
      JSON.stringify(completeOptimization, null, 2),
      "utf8"
    );
    console.log(
      `🗃️  Saved versioned run at data/versions/${path.basename(versionPath)}`
    );
  } catch (e) {
    console.log("⚠️ Failed to save versioned optimization run:", e);
  }

  await writeStatus({
    status: "completed",
    updatedAt: new Date().toISOString(),
  });
}
