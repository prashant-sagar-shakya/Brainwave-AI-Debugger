import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus as dark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { CopyToClipboard } from "react-copy-to-clipboard";
import * as AWS from "aws-sdk";
import { useUser } from "@clerk/clerk-react";
import { FaHistory, FaExclamationTriangle, FaSpinner } from "react-icons/fa";
import { ChevronLeft, ChevronRight, Trash2, X } from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import { debounce, throttle } from "lodash";

const AWS_CONFIG = {
  region: import.meta.env.VITE_AWS_REGION || "ap-south-1",
  accessKeyId: import.meta.env.VITE_AWS_ACCESS_KEY_ID,
  secretAccessKey: import.meta.env.VITE_AWS_SECRET_ACCESS_KEY,
  lambdaFunction: import.meta.env.VITE_AWS_LAMBDA_FUNCTION_NAME || "",
};

if (
  !AWS_CONFIG.accessKeyId ||
  !AWS_CONFIG.secretAccessKey ||
  !AWS_CONFIG.lambdaFunction
) {
  console.error(
    "AWS Configuration is missing. Please check your environment variables (VITE_AWS_ACCESS_KEY_ID, VITE_AWS_SECRET_ACCESS_KEY, VITE_AWS_LAMBDA_FUNCTION_NAME)."
  );
}

AWS.config.update({
  region: AWS_CONFIG.region,
  accessKeyId: AWS_CONFIG.accessKeyId,
  secretAccessKey: AWS_CONFIG.secretAccessKey,
});

const lambda = new AWS.Lambda({
  maxRetries: 3,
  httpOptions: { timeout: 30000 },
});

class ErrorBoundary extends React.Component {
  state = { hasError: false, error: null };
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, errorInfo) {
    console.error("Component Error:", error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      console.error("ErrorBoundary caught:", this.state.error);
      return (
        <div className="bg-red-900/50 p-4 rounded-lg flex items-center space-x-2 my-2">
          <FaExclamationTriangle className="text-red-400" />
          <span className="text-red-200">
            Oops! Something went wrong rendering this part.
          </span>
        </div>
      );
    }
    return this.props.children || null;
  }
}

const DebuggerChatbot = () => {
  const { user } = useUser();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [copiedStates, setCopiedStates] = useState({});
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [showMetrics, setShowMetrics] = useState(true);
  const [cloudWatchLogs, setCloudWatchLogs] = useState([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [messages, setMessages] = useState([]);
  const [chatSessions, setChatSessions] = useState([]);
  const [currentSessionId, setCurrentSessionId] = useState("");
  const [metrics, setMetrics] = useState({
    logEvents: 0,
    errors: 0,
    throttled: 0,
  });
  const [deletingId, setDeletingId] = useState(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [sessionToDelete, setSessionToDelete] = useState(null);

  const messagesEndRef = useRef(null);
  const abortControllerRef = useRef(null);

  const handleError = useCallback((errorSource) => {
    let errorMessage = "An unexpected error occurred. Please try again later.";
    console.error("Error caught:", errorSource);

    if (errorSource instanceof Error) {
      errorMessage = errorSource.message;
      if (
        errorSource.name === "TimeoutError" ||
        errorSource.message.includes("timed out")
      ) {
        errorMessage =
          "The request timed out. The service might be busy or unavailable. Please try again.";
      } else if (errorSource.message.includes("NetworkError")) {
        errorMessage = "Network error. Please check your connection.";
      } else if (
        errorSource.code === "CredentialsError" ||
        errorSource.message.includes("credential")
      ) {
        errorMessage = "AWS credentials error. Please check configuration.";
      } else if (errorSource.message.startsWith("Lambda Error:")) {
        const lambdaMsg = errorSource.message.substring(13).trim();
        const parts = lambdaMsg.split(" - ");
        errorMessage = `Function Error: ${
          parts[1] || parts[0] || "Unknown Lambda issue."
        }`;
      }
    } else if (typeof errorSource === "string") {
      errorMessage = errorSource;
    }

    setError(errorMessage);
    setLoading(false);
  }, []);

  const createNewSession = useCallback(
    () => ({
      id: uuidv4(),
      name: "New Chat",
      timestamp: Date.now(),
      messages: [],
      isNew: true,
    }),
    []
  );

  const generateSessionTitle = useCallback((msgs) => {
    const firstUserMessage = msgs.find((m) => m.sender === "user");
    if (firstUserMessage?.text) {
      const title = firstUserMessage.text.substring(0, 40);
      return title.length < firstUserMessage.text.length
        ? `${title}...`
        : title;
    }
    return "New Chat";
  }, []);

  const switchSession = useCallback(
    (sessionId, allSessions) => {
      const session = allSessions.find((s) => s.id === sessionId);
      if (session) {
        setCurrentSessionId(sessionId);
        setMessages(session.messages || []);
        setError("");
      } else {
        console.warn(`Session ID ${sessionId} not found. Creating a new one.`);
        const newSession = createNewSession();
        setChatSessions((prev) => {
          const filtered = prev.filter((s) => s.id !== sessionId);
          return [newSession, ...filtered];
        });
        setCurrentSessionId(newSession.id);
        setMessages([]);
      }
    },
    [createNewSession]
  );

  const persistSessions = useCallback(
    (sessions) => {
      try {
        const sessionsToSave = sessions
          .map((s) => ({
            id: s.id,
            name: s.name,
            timestamp: s.timestamp,
            messages: s.messages,
            isNew: s.messages.length === 0 ? true : undefined,
          }))
          .filter((s) => s.id);
        localStorage.setItem("chatSessions", JSON.stringify(sessionsToSave));
      } catch (err) {
        console.error("Failed to save chat history:", err);
        handleError("Could not save chat history. Storage might be full.");
      }
    },
    [handleError]
  );

  const deleteChatSession = useCallback((sessionIdToDelete) => {
    setSessionToDelete(sessionIdToDelete);
    setShowDeleteModal(true);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!sessionToDelete) return;

    setDeletingId(sessionToDelete);
    setShowDeleteModal(false);

    try {
      setChatSessions((prevSessions) => {
        const remainingSessions = prevSessions.filter(
          (session) => session.id !== sessionToDelete
        );

        if (sessionToDelete === currentSessionId) {
          if (remainingSessions.length > 0) {
            const sortedSessions = [...remainingSessions].sort(
              (a, b) => (b.timestamp || 0) - (a.timestamp || 0)
            );
            setTimeout(
              () => switchSession(sortedSessions[0].id, sortedSessions),
              0
            );
          } else {
            const newSession = createNewSession();
            setTimeout(() => switchSession(newSession.id, [newSession]), 0);
            return [newSession];
          }
        }
        return remainingSessions;
      });
    } catch (err) {
      console.error("Failed to delete chat session:", err);
      handleError("An error occurred while deleting the chat session.");
    } finally {
      setDeletingId(null);
      setSessionToDelete(null);
    }
  }, [
    sessionToDelete,
    currentSessionId,
    createNewSession,
    switchSession,
    handleError,
  ]);

  const handleNewChat = useCallback(() => {
    setChatSessions((prev) =>
      prev.map((session) => {
        if (
          session.id === currentSessionId &&
          session.isNew &&
          session.messages.length > 0
        ) {
          return {
            ...session,
            name: generateSessionTitle(session.messages),
            isNew: false,
          };
        }
        return session;
      })
    );

    const newSession = createNewSession();

    setChatSessions((prev) => {
      const validPrevSessions = Array.isArray(prev) ? prev : [];
      const updatedSessions = [newSession, ...validPrevSessions];
      setTimeout(() => switchSession(newSession.id, updatedSessions), 0);
      return updatedSessions;
    });

    if (window.innerWidth < 1024) {
      setIsSidebarOpen(false);
    }
  }, [currentSessionId, generateSessionTitle, createNewSession, switchSession]);

  const fetchCloudWatchMetrics = useCallback(async () => {
    if (!AWS_CONFIG.lambdaFunction) {
      console.warn(
        "Lambda function name not configured. Skipping metrics fetch."
      );
      return { logEvents: 0, errors: 0, throttled: 0 };
    }
    try {
      const cloudwatch = new AWS.CloudWatch();
      const now = new Date();
      const startTime = new Date(
        now.getTime() - (24 * 60 * 60 * 1000 + 5 * 60 * 1000)
      );
      const metricParams = {
        Namespace: "AWS/Lambda",
        Dimensions: [
          { Name: "FunctionName", Value: AWS_CONFIG.lambdaFunction },
        ],
        StartTime: startTime,
        EndTime: now,
        Period: 86400,
        Statistics: ["Sum"],
      };

      const [invocationsData, errorsData, throttlesData] = await Promise.all([
        cloudwatch
          .getMetricStatistics({ ...metricParams, MetricName: "Invocations" })
          .promise(),
        cloudwatch
          .getMetricStatistics({ ...metricParams, MetricName: "Errors" })
          .promise(),
        cloudwatch
          .getMetricStatistics({ ...metricParams, MetricName: "Throttles" })
          .promise(),
      ]);

      console.log(
        "[Metrics] Raw Invocations Data:",
        JSON.stringify(invocationsData, null, 2)
      );
      console.log(
        "[Metrics] Raw Errors Data:",
        JSON.stringify(errorsData, null, 2)
      );
      console.log(
        "[Metrics] Raw Throttles Data:",
        JSON.stringify(throttlesData, null, 2)
      );

      const invocationSum = invocationsData.Datapoints?.[0]?.Sum ?? 0;
      const errorSum = errorsData.Datapoints?.[0]?.Sum ?? 0;
      const throttleSum = throttlesData.Datapoints?.[0]?.Sum ?? 0;

      const calculatedMetrics = {
        logEvents: invocationSum,
        errors: errorSum,
        throttled: throttleSum,
      };

      console.log("[Metrics] Calculated Metrics:", calculatedMetrics);

      return calculatedMetrics;
    } catch (err) {
      console.error("[Metrics] Error fetching CloudWatch metrics:", err);
      handleError(
        err instanceof Error
          ? err
          : new Error("Failed to fetch CloudWatch metrics")
      );
      return { logEvents: 0, errors: 0, throttled: 0 };
    }
  }, [handleError]);

  const fetchCloudWatchLogs = useCallback(async () => {
    if (!AWS_CONFIG.lambdaFunction) {
      setCloudWatchLogs(["Lambda function name not configured."]);
      return;
    }
    try {
      abortControllerRef.current?.abort("New log request started");
      abortControllerRef.current = new AbortController();
      const signal = abortControllerRef.current.signal;

      const cloudwatchlogs = new AWS.CloudWatchLogs();
      const logGroupName = `/aws/lambda/${AWS_CONFIG.lambdaFunction}`;
      console.log("[Logs] Fetching CloudWatch Logs for group:", logGroupName);
      const params = {
        logGroupName: logGroupName,
        limit: 20,
        startTime: Date.now() - 60 * 60 * 1000,
        interleaved: true,
      };
      const data = await cloudwatchlogs.filterLogEvents(params).promise();

      if (signal.aborted) {
        console.log("[Logs] Log fetch aborted");
        return;
      }

      console.log("[Logs] Raw Logs Data:", JSON.stringify(data, null, 2));

      const logs =
        data.events?.map((e) => e.message?.trim() || "Empty log message") || [];

      if (logs.length === 0) {
        console.log("[Logs] No recent logs found.");
        setCloudWatchLogs(["No recent logs found."]);
      } else {
        setCloudWatchLogs(logs);
      }
    } catch (err) {
      if (
        err.name !== "AbortError" &&
        err.message !== "New log request started"
      ) {
        console.error("[Logs] Error fetching CloudWatch logs:", err);
        handleError(
          err instanceof Error
            ? err
            : new Error("Failed to fetch CloudWatch logs")
        );
        setCloudWatchLogs(["Error fetching logs."]);
      } else {
        console.log("[Logs] Log fetch aborted or superseded:", err.message);
      }
    }
  }, [handleError]);

  const handleSearch = useMemo(
    () =>
      throttle(
        async (termToSearch) => {
          const trimmedTerm = termToSearch.trim();
          if (!trimmedTerm) return;
          if (!user) {
            handleError("User not authenticated. Please log in.");
            return;
          }
          if (!AWS_CONFIG.lambdaFunction) {
            handleError("Lambda function not configured.");
            return;
          }

          setLoading(true);
          setError("");
          setSearchTerm("");

          const userMessage = {
            id: uuidv4(),
            sender: "user",
            text: trimmedTerm,
            timestamp: Date.now(),
          };

          setMessages((prev) => [...prev, userMessage]);

          setChatSessions((prevSessions) =>
            prevSessions.map((session) => {
              if (session.id === currentSessionId) {
                const updatedMessages = [
                  ...(session.messages || []),
                  userMessage,
                ];
                return {
                  ...session,
                  messages: updatedMessages,
                  name:
                    session.isNew && session.messages.length === 0
                      ? generateSessionTitle(updatedMessages)
                      : session.name,
                  isNew: false,
                  timestamp: Date.now(),
                };
              }
              return session;
            })
          );

          try {
            const lambdaPayload = {
              body: JSON.stringify({ prompt: trimmedTerm, userId: user.id }),
            };

            console.log(
              "[Lambda] Invoking Lambda function:",
              AWS_CONFIG.lambdaFunction,
              "with payload:",
              lambdaPayload.body
            );

            const response = await lambda
              .invoke({
                FunctionName: AWS_CONFIG.lambdaFunction,
                InvocationType: "RequestResponse",
                Payload: JSON.stringify(lambdaPayload),
              })
              .promise();

            console.log("[Lambda] Raw response:", JSON.stringify(response));

            if (response.FunctionError) {
              let errorPayload = "Unknown Lambda error";
              try {
                const parsedPayload = JSON.parse(response.Payload.toString());
                errorPayload =
                  parsedPayload.errorMessage ||
                  parsedPayload.errorType ||
                  JSON.stringify(parsedPayload);
              } catch (parseErr) {
                errorPayload =
                  response.Payload?.toString() ||
                  "Could not parse error payload";
              }
              console.error(
                "[Lambda] FunctionError:",
                response.FunctionError,
                "Payload:",
                errorPayload
              );
              throw new Error(
                `Lambda Error: ${response.FunctionError} - ${errorPayload}`
              );
            }

            let resultBody;
            let responsePayloadString = response.Payload?.toString() || "{}";
            console.log(
              "[Lambda] Success Payload String:",
              responsePayloadString
            );

            try {
              const responsePayload = JSON.parse(responsePayloadString);

              if (
                responsePayload.statusCode &&
                typeof responsePayload.body === "string"
              ) {
                console.log(
                  "[Lambda] Detected API Gateway structure. Status:",
                  responsePayload.statusCode
                );
                if (responsePayload.statusCode >= 400) {
                  let errorBodyMsg = `Lambda invocation failed with status ${responsePayload.statusCode}`;
                  try {
                    const errorBody = JSON.parse(responsePayload.body || "{}");
                    errorBodyMsg =
                      errorBody?.error ||
                      errorBody?.message ||
                      responsePayload.body ||
                      errorBodyMsg;
                  } catch (bodyParseErr) {
                    errorBodyMsg = responsePayload.body || errorBodyMsg;
                  }
                  console.error("[Lambda] Application Error:", errorBodyMsg);
                  throw new Error(errorBodyMsg);
                }
                resultBody = JSON.parse(responsePayload.body || "{}");
              } else {
                console.log("[Lambda] Assuming direct JSON response.");
                resultBody = responsePayload;
              }
            } catch (parseErr) {
              console.error(
                "[Lambda] Failed to parse Lambda response payload:",
                responsePayloadString,
                parseErr
              );
              throw new Error("Received an invalid response from the service.");
            }

            console.log("[Lambda] Parsed Result Body:", resultBody);

            const awsResponseText =
              resultBody.response ||
              resultBody.message ||
              "No meaningful response received.";

            const isMarkdown =
              typeof awsResponseText === "string" &&
              (awsResponseText.includes("```") ||
                awsResponseText.includes("\n*") ||
                awsResponseText.includes("\n- "));

            const awsMessage = {
              id: uuidv4(),
              sender: "aws",
              text: awsResponseText,
              isMarkdown: isMarkdown,
              timestamp: Date.now(),
            };

            setMessages((prev) => [...prev, awsMessage]);
            setChatSessions((prev) =>
              prev.map((session) =>
                session.id === currentSessionId
                  ? {
                      ...session,
                      messages: [...(session.messages || []), awsMessage],
                    }
                  : session
              )
            );
          } catch (err) {
            console.error("[Search] Error during handleSearch:", err);
            handleError(err);

            const currentError =
              (typeof err === "string" ? err : err.message) ||
              "Could not get response.";
            const errorMessage = {
              id: uuidv4(),
              sender: "system",
              text: `Error: ${currentError}`,
              isMarkdown: false,
              timestamp: Date.now(),
            };
            setMessages((prev) => [...prev, errorMessage]);
            setChatSessions((prev) =>
              prev.map((session) =>
                session.id === currentSessionId
                  ? {
                      ...session,
                      messages: [...(session.messages || []), errorMessage],
                    }
                  : session
              )
            );
          } finally {
            setLoading(false);
          }
        },
        1000,
        { leading: true, trailing: false }
      ),
    [handleError, user, currentSessionId, generateSessionTitle]
  );

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  const toggleMetricsPanel = useCallback(
    () => setShowMetrics((prev) => !prev),
    []
  );
  const toggleHistorySidebar = useCallback(
    () => setIsSidebarOpen((prev) => !prev),
    []
  );

  const handleCopy = useCallback((id) => {
    setCopiedStates((prev) => ({ ...prev, [id]: true }));
    const timer = setTimeout(() => {
      setCopiedStates((prev) => ({ ...prev, [id]: false }));
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    console.log("[Effect] Initializing component and loading sessions.");
    try {
      const savedSessions = localStorage.getItem("chatSessions");
      let loadedSessions = [];
      if (savedSessions) {
        loadedSessions = JSON.parse(savedSessions);
        if (!Array.isArray(loadedSessions)) {
          console.warn(
            "[Effect] Invalid chat history found in localStorage. Resetting."
          );
          loadedSessions = [];
        } else {
          loadedSessions = loadedSessions
            .map((s) => ({
              id: s.id || uuidv4(),
              name: s.name || "Chat",
              timestamp: s.timestamp || Date.now(),
              messages: Array.isArray(s.messages) ? s.messages : [],
              isNew: s.messages?.length === 0 ? true : undefined,
            }))
            .filter((s) => s.id);
        }
      }

      if (loadedSessions.length > 0) {
        loadedSessions.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        console.log("[Effect] Loaded sessions:", loadedSessions.length);
        setChatSessions(loadedSessions);
        switchSession(loadedSessions[0].id, loadedSessions);
      } else {
        console.log("[Effect] No valid sessions found, creating a new one.");
        const newSession = createNewSession();
        setChatSessions([newSession]);
        switchSession(newSession.id, [newSession]);
      }
    } catch (err) {
      console.error("[Effect] Failed to load chat history:", err);
      handleError("Could not load previous chat sessions.");
      const newSession = createNewSession();
      setChatSessions([newSession]);
      switchSession(newSession.id, [newSession]);
    }
  }, [createNewSession, switchSession, handleError]);

  useEffect(() => {
    if (chatSessions.length > 0) {
      const debouncedPersist = debounce(() => {
        console.log("[Effect] Persisting sessions to localStorage...");
        persistSessions(chatSessions);
      }, 500);
      debouncedPersist();
      return () => debouncedPersist.cancel();
    }
  }, [chatSessions, persistSessions]);

  useEffect(() => {
    if (messages.length > 0) {
      scrollToBottom();
    }
  }, [messages, scrollToBottom]);

  useEffect(() => {
    console.log("[Effect] Setting up periodic data fetch interval.");
    const fetchAndSetData = async () => {
      console.log("[Effect] Performing periodic fetch for metrics and logs.");
      try {
        await Promise.all([
          fetchCloudWatchMetrics().then(setMetrics),
          fetchCloudWatchLogs(),
        ]);
        console.log("[Effect] Periodic fetch complete.");
      } catch (error) {
        console.error("[Effect] Error during periodic fetch execution:", error);
      }
    };

    fetchAndSetData();
    const intervalId = setInterval(fetchAndSetData, 30000);

    return () => {
      console.log("[Effect] Clearing periodic data fetch interval.");
      clearInterval(intervalId);
      abortControllerRef.current?.abort("Component unmounting");
    };
  }, [fetchCloudWatchMetrics, fetchCloudWatchLogs]);

  useEffect(() => {
    return () => {
      console.log("[Effect] Cancelling throttled search function.");
      handleSearch.cancel();
    };
  }, [handleSearch]);

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 1024) {
        // Mobile behavior (no forced changes now)
      } else {
        if (!showMetrics) setShowMetrics(true);
        if (isSidebarOpen) setIsSidebarOpen(false);
      }
    };
    window.addEventListener("resize", handleResize);
    handleResize();
    return () => window.removeEventListener("resize", handleResize);
  }, [showMetrics, isSidebarOpen]);

  const renderMessage = useCallback(
    (message) => (
      <ErrorBoundary key={message.id}>
        <div
          className={`flex ${
            message.sender === "user"
              ? "justify-end"
              : message.sender === "system"
              ? "justify-center"
              : "justify-start"
          } mb-4 animate-fade-in`}
        >
          {message.sender === "aws" && (
            <img
              src="https://cdn0.iconfinder.com/data/icons/social-flat-rounded-rects/512/aws-512.png"
              alt="AWS"
              className="rounded-full w-8 h-8 lg:w-10 lg:h-10 mr-2 lg:mx-2 self-start object-cover shadow-md flex-shrink-0 bg-white p-0.5"
            />
          )}

          <div
            className={`p-3 lg:p-4 rounded-lg max-w-sm sm:max-w-md md:max-w-lg lg:max-w-2xl xl:max-w-3xl shadow-md ${
              message.sender === "user"
                ? "bg-blue-600 text-white"
                : message.sender === "system"
                ? "bg-red-800/70 text-red-100 text-sm italic w-full max-w-xl text-center"
                : "bg-gray-700 text-gray-100"
            }`}
          >
            {message.isMarkdown ? (
              <div className="prose prose-sm prose-invert max-w-none">
                <ReactMarkdown
                  components={{
                    code({ node, inline, className, children, ...props }) {
                      const match = /language-(\w+)/.exec(className || "");
                      const codeText = String(children).replace(/\n$/, "");

                      return !inline && match ? (
                        <div className="relative my-2 bg-[#1e1e1e] rounded overflow-hidden">
                          <span className="text-xs text-gray-400 absolute top-1 left-2 capitalize">
                            {match[1]}
                          </span>
                          <SyntaxHighlighter
                            style={dark}
                            language={match[1]}
                            PreTag="div"
                            customStyle={{
                              margin: 0,
                              padding: "1.5rem 1rem 1rem 1rem",
                              backgroundColor: "transparent",
                              fontSize: "0.875rem",
                            }}
                            codeTagProps={{
                              style: {
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-all",
                              },
                            }}
                            wrapLongLines={true}
                            {...props}
                          >
                            {codeText}
                          </SyntaxHighlighter>
                          <CopyToClipboard
                            text={codeText}
                            onCopy={() => handleCopy(message.id + "-code")}
                          >
                            <button className="absolute top-1 right-1 bg-gray-600 hover:bg-gray-500 text-white px-2 py-0.5 rounded text-xs transition-colors z-10">
                              {copiedStates[message.id + "-code"]
                                ? "Copied!"
                                : "Copy"}
                            </button>
                          </CopyToClipboard>
                        </div>
                      ) : (
                        <code
                          className="bg-gray-600/50 px-1 py-0.5 rounded text-sm"
                          {...props}
                        >
                          {children}
                        </code>
                      );
                    },
                    a: ({ node, ...props }) => (
                      <a
                        {...props}
                        className="text-blue-400 hover:underline"
                        target="_blank"
                        rel="noopener noreferrer"
                      />
                    ),
                    ul: ({ node, ...props }) => (
                      <ul
                        {...props}
                        className="list-disc list-inside my-1 pl-2"
                      />
                    ),
                    ol: ({ node, ...props }) => (
                      <ol
                        {...props}
                        className="list-decimal list-inside my-1 pl-2"
                      />
                    ),
                    p: ({ node, ...props }) => (
                      <p {...props} className="mb-2 last:mb-0" />
                    ),
                  }}
                >
                  {message.text}
                </ReactMarkdown>
              </div>
            ) : (
              <div className="text-gray-100 whitespace-pre-wrap break-words">
                {message.text}
              </div>
            )}
          </div>

          {message.sender === "user" && user?.imageUrl && (
            <img
              src={user.imageUrl}
              alt="User"
              className="rounded-full w-8 h-8 lg:w-10 lg:h-10 ml-2 lg:mx-2 self-start object-cover shadow-md flex-shrink-0"
            />
          )}
          {message.sender === "user" && !user?.imageUrl && (
            <div className="rounded-full w-8 h-8 lg:w-10 lg:h-10 ml-2 lg:mx-2 self-start shadow-md flex-shrink-0 bg-blue-800 flex items-center justify-center text-white font-bold text-lg">
              {user?.firstName?.charAt(0) || "U"}
            </div>
          )}
        </div>
      </ErrorBoundary>
    ),
    [copiedStates, user?.imageUrl, user?.firstName, handleCopy]
  );

  return (
    <div className="flex flex-col lg:flex-row h-full bg-gray-900 text-gray-100 overflow-hidden relative">
      {showMetrics && (
        <div className="w-full lg:w-1/4 lg:max-w-xs xl:max-w-sm border-b lg:border-b-0 lg:border-r border-gray-700 p-4 flex flex-col h-auto lg:h-full overflow-y-auto hide-scrollbar">
          <button
            onClick={toggleMetricsPanel}
            className="lg:hidden text-gray-400 hover:text-white absolute top-2 right-2 z-10 p-1 bg-gray-800/50 rounded-full"
            aria-label="Close metrics"
          >
            <X size={20} />
          </button>
          <h3 className="text-lg font-semibold mb-4 pt-6 lg:pt-0">
            CloudWatch Metrics
          </h3>
          <div className="bg-gray-800/50 rounded-lg p-3 mb-4">
            <h4
              className="text-sm font-medium mb-2 text-gray-300 truncate"
              title={AWS_CONFIG.lambdaFunction || "N/A"}
            >
              {AWS_CONFIG.lambdaFunction
                ? `Fn: ${AWS_CONFIG.lambdaFunction
                    .split(":")
                    .slice(-1)[0]
                    .split("-")
                    .slice(-2)
                    .join("-")}`
                : "No Function Set"}
              <span className="text-xs block text-gray-400">Last 24 Hours</span>
            </h4>
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-gray-700/50 p-2 rounded text-center">
                <p className="text-xs text-gray-400">Invokes</p>
                <p className="text-lg font-bold">{metrics.logEvents}</p>
              </div>
              <div className="bg-gray-700/50 p-2 rounded text-center">
                <p className="text-xs text-gray-400">Errors</p>
                <p
                  className={`text-lg font-bold ${
                    metrics.errors > 0 ? "text-red-400" : ""
                  }`}
                >
                  {metrics.errors}
                </p>
              </div>
              <div className="bg-gray-700/50 p-2 rounded text-center">
                <p className="text-xs text-gray-400">Throttles</p>
                <p
                  className={`text-lg font-bold ${
                    metrics.throttled > 0 ? "text-yellow-400" : ""
                  }`}
                >
                  {metrics.throttled}
                </p>
              </div>
            </div>
          </div>
          <h3 className="text-lg font-semibold mb-2">Recent Logs</h3>
          <div className="flex-1 overflow-y-auto space-y-1.5 bg-gray-800/30 p-2 rounded hide-scrollbar min-h-[150px]">
            {cloudWatchLogs.length > 0 &&
            typeof cloudWatchLogs[0] === "string" ? (
              cloudWatchLogs.map((log, i) => (
                <div
                  key={i}
                  className={`p-1.5 rounded text-xs font-mono break-words ${
                    log === "Error fetching logs." ||
                    log === "Lambda function name not configured."
                      ? "bg-yellow-900/60 text-yellow-100"
                      : log.toLowerCase().includes("error")
                      ? "bg-red-900/60 text-red-100"
                      : log.toLowerCase().includes("warn") ||
                        log.toLowerCase().includes("warning")
                      ? "bg-yellow-900/60 text-yellow-100"
                      : "bg-gray-700/50 text-gray-300"
                  }`}
                  title={log}
                >
                  {log.length > 150 ? log.substring(0, 150) + "..." : log}
                </div>
              ))
            ) : (
              <p className="text-sm text-gray-500 italic p-2 text-center">
                Loading logs or none found...
              </p>
            )}
          </div>
        </div>
      )}
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        <div className="p-3 lg:p-4 border-b border-gray-700 flex flex-col sm:flex-row space-y-2 sm:space-y-0 sm:space-x-4 items-center">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSearch(searchTerm);
              }
            }}
            placeholder="Ask AWS Debugger (e.g., 'Why is my Lambda timing out?')"
            className="flex-1 w-full bg-gray-800 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-500 disabled:opacity-60"
            disabled={loading}
          />
          <button
            onClick={() => handleSearch(searchTerm)}
            disabled={loading || !searchTerm.trim()}
            className="w-full sm:w-auto bg-blue-600 px-5 py-2 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center space-x-2 flex-shrink-0"
          >
            {loading ? (
              <>
                <FaSpinner className="animate-spin" size={18} />
                <span>Asking...</span>
              </>
            ) : (
              <span>Ask</span>
            )}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4 hide-scrollbar relative">
          {messages.length === 0 && !loading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center text-gray-600 p-8 pointer-events-none">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="w-20 h-20 mb-4 opacity-50 text-gray-700"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M20.55 4.18 C20.33 4.07 20.08 4 19.82 4 L18 4 L18 3 C18 2.45 17.55 2 17 2 L16 2 L16 1 C16 0.45 15.55 0 15 0 L9 0 C8.45 0 8 0.45 8 1 L8 2 L7 2 C6.45 2 6 2.45 6 3 L6 4 L4.18 4 C3.66 4 3.21 4.33 3.04 4.82 C2.87 5.3 3.01 5.84 3.4 6.18 L4.8 7.35 C4.47 7.81 4.22 8.34 4.08 8.91 L2.18 8.91 C1.66 8.91 1.21 9.24 1.04 9.73 C0.87 10.22 1.01 10.76 1.4 11.1 L3.47 12.85 C3.17 13.35 3 13.9 3 14.47 L3 15.09 C3 15.61 3.33 16.06 3.82 16.23 C4.3 16.4 4.84 16.26 5.18 15.87 L6.88 14.49 C7.38 14.8 7.94 15.03 8.53 15.17 L8.53 17.08 C8.53 17.6 8.86 18.05 9.35 18.22 C9.84 18.39 10.38 18.25 10.72 17.86 L12 16.85 L13.28 17.86 C13.62 18.25 14.16 18.39 14.65 18.22 C15.14 18.05 15.47 17.6 15.47 17.08 L15.47 15.17 C16.06 15.03 16.62 14.8 17.12 14.49 L18.82 15.87 C19.16 16.26 19.7 16.4 20.18 16.23 C20.67 16.06 21 15.61 21 15.09 L21 14.47 C21 13.9 20.83 13.35 20.53 12.85 L22.6 11.1 C22.99 10.76 23.13 10.22 22.96 9.73 C22.79 9.24 22.34 8.91 21.82 8.91 L19.92 8.91 C19.78 8.34 19.53 7.81 19.2 7.35 L20.6 6.18 C20.99 5.84 21.13 5.3 20.96 4.82 C20.87 4.53 20.72 4.31 20.55 4.18 Z M10 2 L14 2 L14 3 L10 3 L10 2 Z M8 4 L16 4 L16 5.5 C16 6.33 15.33 7 14.5 7 L9.5 7 C8.67 7 8 6.33 8 5.5 L8 4 Z M13.47 9.5 C14.3 9.5 15 10.17 15 11 C15 11.83 14.33 12.5 13.53 12.5 C13.53 12.5 13.53 12.5 13.53 12.5 C12.7 12.5 12 11.83 12 11 C12 10.17 12.67 9.5 13.47 9.5 Z M10.47 9.5 C11.3 9.5 12 10.17 12 11 C12 11.83 11.33 12.5 10.53 12.5 C10.53 12.5 10.53 12.5 10.53 12.5 C9.7 12.5 9 11.83 9 11 C9 10.17 9.67 9.5 10.47 9.5 Z M19 14 L17.5 14 C16.67 14 16 13.33 16 12.5 L16 11 C16 10.17 16.67 9.5 17.5 9.5 L19 9.5 C19.83 9.5 20.5 10.17 20.5 11 L20.5 12.5 C20.5 13.33 19.83 14 19 14 Z"></path>
              </svg>
              <h2 className="text-xl font-semibold text-gray-500">
                AWS Debugger
              </h2>
              <p className="mt-2">
                Start a new debugging session by asking a question below.
              </p>
            </div>
          )}
          {messages.map(renderMessage)}
          {loading && messages.length > 0 && (
            <div className="flex justify-center items-center pt-4">
              <FaSpinner className="animate-spin text-blue-500" size={24} />
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>
      <div
        className={`fixed inset-0 z-40 bg-gray-900/95 backdrop-blur-sm p-4 flex flex-col lg:static lg:z-auto lg:bg-transparent lg:backdrop-blur-none lg:w-1/4 lg:max-w-xs xl:max-w-sm lg:border-l border-gray-700 lg:h-full transition-transform duration-300 ease-in-out ${
          isSidebarOpen ? "translate-x-0" : "-translate-x-full"
        } lg:translate-x-0 overflow-y-auto hide-scrollbar `}
        aria-label="Chat History"
      >
        <div className="flex justify-between items-center mb-4 flex-shrink-0">
          <h3 className="text-lg font-semibold">Chat History</h3>
          <button
            onClick={handleNewChat}
            className="text-sm px-3 py-1 bg-orange-500 rounded-full hover:bg-orange-600 transition-colors text-white"
            title="Start a new chat session"
          >
            + New Chat
          </button>
          <button
            onClick={toggleHistorySidebar}
            className="lg:hidden text-gray-400 hover:text-white p-1"
            aria-label="Close history"
          >
            <X size={24} />
          </button>
        </div>

        <div className="space-y-1.5 flex-1 overflow-y-auto hide-scrollbar pr-1">
          {chatSessions.map((session) => (
            <div
              key={session.id}
              className={`group flex items-center justify-between w-full p-2 rounded cursor-pointer transition-colors duration-150 truncate ${
                session.id === currentSessionId
                  ? "bg-blue-700/60"
                  : "bg-gray-800/70 hover:bg-gray-700/80"
              }`}
              onClick={() => {
                if (session.id !== currentSessionId)
                  switchSession(session.id, chatSessions);
                if (window.innerWidth < 1024) setIsSidebarOpen(false);
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  if (session.id !== currentSessionId)
                    switchSession(session.id, chatSessions);
                  if (window.innerWidth < 1024) setIsSidebarOpen(false);
                }
              }}
            >
              <div className="flex-1 text-left truncate mr-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="truncate font-medium" title={session.name}>
                    {session.isNew && session.messages.length === 0 ? (
                      <i className="text-gray-400">New Chat</i>
                    ) : (
                      session.name
                    )}
                  </span>
                </div>
                <div className="text-xs text-gray-400 mt-0.5">
                  {new Date(
                    session.timestamp || Date.now()
                  ).toLocaleDateString()}{" "}
                  {new Date(session.timestamp || Date.now()).toLocaleTimeString(
                    [],
                    { hour: "2-digit", minute: "2-digit" }
                  )}
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  deleteChatSession(session.id);
                }}
                className={`p-1 text-gray-400 hover:text-red-500 focus:text-red-500 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity flex-shrink-0 rounded-full hover:bg-gray-600/50 focus:outline-none focus:ring-1 focus:ring-red-500 ${
                  deletingId === session.id ? "opacity-100 animate-pulse" : ""
                }`}
                title="Delete chat"
                disabled={deletingId === session.id}
                aria-label={`Delete chat session titled ${session.name}`}
              >
                {deletingId === session.id ? (
                  <FaSpinner className="w-4 h-4 animate-spin" />
                ) : (
                  <Trash2 className="w-4 h-4" />
                )}
              </button>
            </div>
          ))}
          {chatSessions.length === 0 && (
            <p className="text-sm text-gray-500 italic p-2 text-center">
              No chat history yet.
            </p>
          )}
        </div>
      </div>
      <button
        onClick={toggleMetricsPanel}
        className={`lg:hidden fixed bottom-20 ${
          isSidebarOpen ? "right-20" : "right-4"
        } bg-gray-700 p-3 rounded-full shadow-lg z-50 transition-all text-gray-300 hover:text-white hover:bg-gray-600`}
        aria-label={showMetrics ? "Hide Metrics" : "Show Metrics"}
        title={showMetrics ? "Hide Metrics" : "Show Metrics"}
      >
        {!showMetrics ? <ChevronLeft size={20} /> : <ChevronRight size={20} />}
      </button>
      <button
        onClick={toggleHistorySidebar}
        className="lg:hidden fixed bottom-4 right-4 bg-blue-600 p-3 rounded-full shadow-lg z-50 transition-all text-white hover:bg-blue-700"
        aria-label={isSidebarOpen ? "Close History" : "Open History"}
        title={isSidebarOpen ? "Close History" : "Open History"}
      >
        {isSidebarOpen ? <X size={20} /> : <FaHistory size={20} />}
      </button>
      {error && (
        <div className="fixed bottom-4 left-4 right-4 md:left-auto md:max-w-md bg-red-600 p-4 rounded-lg shadow-lg flex items-center space-x-3 z-[60] animate-slide-up">
          <FaExclamationTriangle
            className="text-white flex-shrink-0"
            size={20}
          />
          <span className="text-white text-sm flex-1 break-words">{error}</span>
          <button
            onClick={() => setError("")}
            className="text-red-100 hover:text-white ml-auto flex-shrink-0 p-1 rounded-full hover:bg-red-700 focus:outline-none focus:ring-1 focus:ring-white"
            aria-label="Dismiss error"
          >
            <X size={18} />
          </button>
        </div>
      )}
      {showDeleteModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          aria-modal="true"
          role="dialog"
        >
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => {
              setShowDeleteModal(false);
              setSessionToDelete(null);
            }}
            aria-hidden="true"
          />
          <div className="relative bg-gray-800 p-6 rounded-lg shadow-xl max-w-md w-full mx-4 border border-gray-700">
            <h3 className="text-xl font-semibold text-gray-100 mb-4">
              Delete Chat Session
            </h3>
            <p className="text-gray-300 mb-6">
              Are you sure you want to delete this chat session? This action
              cannot be undone.
            </p>
            <div className="flex justify-end space-x-4">
              <button
                onClick={() => {
                  setShowDeleteModal(false);
                  setSessionToDelete(null);
                }}
                className="px-4 py-2 text-sm font-medium text-gray-300 hover:text-white bg-gray-700 rounded-md transition-colors hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-gray-500"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDelete}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700 transition-colors focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 focus:ring-offset-gray-800"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DebuggerChatbot;
