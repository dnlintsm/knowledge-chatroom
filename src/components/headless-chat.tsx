import { useAgent } from "@copilotkit/react-core/v2";
import { useCallback, useState } from "react";
import { v4 as uuidv4 } from "uuid";

export const HeadlessChat = () => {
  const { agent } = useAgent();
  const [message, setMessage] = useState("");

  const sendMessage = useCallback(
    (message: string) => {
      agent.addMessage({
        role: "user",
        id: uuidv4(),
        content: message,
      });
      agent.runAgent();
      setMessage("");
    },
    [agent],
  );

  return (
    <div>
      <h1>Chat</h1>
      {agent.messages.map((message) => (
        <div key={message.id}>
          <p>{JSON.stringify(message.content)}</p>
        </div>
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!message.trim()) return;
          sendMessage(message);
        }}
      >
        <input
          type="text"
          aria-label="Message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <button type="submit" disabled={!message.trim()}>
          Send
        </button>
      </form>
    </div>
  );
};
