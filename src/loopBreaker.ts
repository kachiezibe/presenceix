import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { createClient } from '@supabase/supabase-js';

// Initialize Clients
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder-url.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder-key'
);

interface WorkflowContext {
  workflowId: string;
  userId: string;
  actionName: string;
  payloadHash: string;
  depth: number;
}

export class LoopBreaker {
  private redisClient: Redis;
  private maxDepth: number = 5;
  private slidingWindowSec: number = 300; // 5 minutes

  constructor(redisClient: Redis) {
    this.redisClient = redisClient;
  }

  /**
   * Generates a unique tracking key for a specific user and workflow action
   */
  private getTrackingKey(userId: string, workflowId: string, actionName: string): string {
    return `loopbreaker:user:${userId}:wf:${workflowId}:act:${actionName}`;
  }

  /**
   * Analyzes current execution state and halts loops before they cascade
   */
  async shouldHalt(context: WorkflowContext): Promise<boolean> {
    const { userId, workflowId, actionName, payloadHash } = context;
    const key = this.getTrackingKey(userId, workflowId, actionName);

    // Multi-transaction block in Redis to update metrics atomically
    const pipeline = this.redisClient.multi();
    pipeline.incr(key);
    pipeline.expire(key, this.slidingWindowSec);
    pipeline.get(`${key}:last_hash`);
    pipeline.set(`${key}:last_hash`, payloadHash, 'EX', this.slidingWindowSec);

    const results = await pipeline.exec();
    if (!results) {
      throw new Error('Redis transaction execution failed');
    }

    // Results in ioredis format: [ [err, result], [err, result], ... ]
    const currentDepth = results[0][1] as number;
    const lastHash = results[2][1] as string | null;

    // Condition 1: Exceeded recursion depth threshold
    if (currentDepth > this.maxDepth) {
      console.warn(`[LOOP DETECTED] User ${userId} exceeded max recursion depth (${currentDepth}/${this.maxDepth}) on action ${actionName}`);
      return true;
    }

    // Condition 2: Payload hash matches previous execution (Infinite same-state loop)
    if (lastHash && lastHash === payloadHash) {
      console.warn(`[LOOP DETECTED] Duplicate state pattern detected for User ${userId} on action ${actionName}. Hash: ${payloadHash}`);
      return true;
    }

    return false;
  }

  /**
   * Executes safety fail-safe shutdown: pauses queue, logs telemetry, and alerts admin
   */
  async triggerFailSafe(context: WorkflowContext, telemetry: any, queue: Queue): Promise<void> {
    const { userId, workflowId, actionName } = context;
    console.error(`[CRITICAL] Initiating Loop-Breaker Fail-Safe for User: ${userId}, Workflow: ${workflowId}`);

    try {
      // 1. Pause execution queue for the specific user/workflow partition
      await queue.pause();
      console.log(`[FAIL-SAFE] BullMQ queue successfully paused to prevent runaway API billing.`);

      // 2. Persist the crash telemetry payload to Supabase for debugging audits
      const { error } = await supabase
        .from('telemetry_logs')
        .insert([{
          event_type: 'CRASH_STATE',
          user_id: userId,
          workflow_id: workflowId,
          action_name: actionName,
          metadata: {
            ...telemetry,
            timestamp: new Date().toISOString(),
            status: 'HALTED_BY_LOOP_BREAKER'
          }
        }]);

      if (error) throw error;
      console.log(`[FAIL-SAFE] Crash telemetry successfully written to Supabase.`);

      // 3. Notify administrator via asynchronous alerting webhook (e.g. Slack/WhatsApp/Email)
      await this.sendEmergencyAlert(userId, workflowId, actionName, telemetry);

    } catch (err) {
      console.error(`[FAIL-SAFE-ERROR] Failed to execute full fail-safe:`, err);
    }
  }

  /**
   * Dispatches emergency alert to systems engineer
   */
  private async sendEmergencyAlert(userId: string, workflowId: string, actionName: string, telemetry: any): Promise<void> {
    const webhookUrl = process.env.EMERGENCY_ALERTS_WEBHOOK;
    if (!webhookUrl) {
      console.warn('[FAIL-SAFE] Webhook alert skipped: EMERGENCY_ALERTS_WEBHOOK not configured.');
      return;
    }

    const alertPayload = {
      text: `🚨 *CRITICAL: PresenceIX Loop-Breaker Active* 🚨\n` +
            `*User ID:* ${userId}\n` +
            `*Workflow ID:* ${workflowId}\n` +
            `*Triggering Action:* ${actionName}\n` +
            `*Reason:* Execution loop halted. BullMQ queue has been paused. Telemetry logged to Supabase.\n` +
            `*Telemetry Summary:* \`${JSON.stringify(telemetry).substring(0, 200)}...\``
    };

    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(alertPayload)
      });
      console.log('[FAIL-SAFE] Emergency Slack/Teams webhook alert sent successfully.');
    } catch (e) {
      console.error('[FAIL-SAFE] Failed to send webhook alert:', e);
    }
  }
}
