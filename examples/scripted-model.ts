import { AIMessage } from 'langchain';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';

/** Offline model for a real LangChain agent loop. The tool executor and middleware are real. */
export class ScriptedModel extends BaseChatModel {
  private index = 0;
  readonly seen: BaseMessage[][] = [];

  constructor(private readonly responses: AIMessage[]) {
    super({});
  }

  _llmType(): string {
    return 'offline-script';
  }

  bindTools(): this {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push(messages);
    const message = this.responses[this.index++];
    if (!message) throw new Error('Script exhausted: the agent called the model unexpectedly');
    return { generations: [{ text: String(message.content), message }] };
  }
}
