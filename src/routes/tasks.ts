import { Router, type Request, type Response, type NextFunction } from 'express';

import { AppError } from '../errors/app-error';
import {
  taskRepository as defaultTaskRepository,
  type RuntimeTaskSource,
  type TaskRepository,
} from '../services/task-repository';

interface TaskRouteDependencies {
  taskRepository?: TaskRepository;
}

type TaskListQuery = {
  userId?: string | string[];
};

type DeleteTaskQuery = {
  userId?: string | string[];
};

type TaskIdParams = {
  taskId: string;
};

interface CreateTaskBody {
  userId?: unknown;
  alertScope?: unknown;
  cron?: unknown;
  enabled?: unknown;
  source?: unknown;
}

interface UpdateTaskBody {
  userId?: unknown;
  alertScope?: unknown;
  cron?: unknown;
  enabled?: unknown;
}

const getRequiredText = (value: unknown, field: string): string => {
  if (typeof value !== 'string') {
    throw new AppError(400, 'INVALID_ARGUMENT', `${field} must be a non-empty string.`, [
      {
        field,
        message: 'Expected a non-empty string.',
      },
    ]);
  }

  const normalizedValue = value.trim();

  if (!normalizedValue) {
    throw new AppError(400, 'INVALID_ARGUMENT', `${field} must be a non-empty string.`, [
      {
        field,
        message: 'Expected a non-empty string.',
      },
    ]);
  }

  return normalizedValue;
};

const getRequiredUserIdFromQuery = (
  value: string | string[] | undefined,
): string => {
  if (Array.isArray(value)) {
    throw new AppError(400, 'INVALID_ARGUMENT', 'userId must be a single string value.', [
      {
        field: 'userId',
        message: 'Expected a single string value.',
      },
    ]);
  }

  return getRequiredText(value, 'userId');
};

const getOptionalBoolean = (
  value: unknown,
  field: string,
): boolean | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    throw new AppError(400, 'INVALID_ARGUMENT', `${field} must be a boolean value.`, [
      {
        field,
        message: 'Expected a boolean value.',
      },
    ]);
  }

  return value;
};

const getOptionalText = (
  value: unknown,
  field: string,
): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  return getRequiredText(value, field);
};

const assertAllowedKeys = (
  record: Record<string, unknown>,
  allowedKeys: string[],
): void => {
  const unknownKeys = Object.keys(record).filter((key) => !allowedKeys.includes(key));

  if (unknownKeys.length === 0) {
    return;
  }

  throw new AppError(
    400,
    'INVALID_ARGUMENT',
    `Unsupported fields: ${unknownKeys.join(', ')}.`,
    unknownKeys.map((field) => ({
      field,
      message: 'This field is not supported in the current API.',
    })),
  );
};

const getObjectBody = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(400, 'INVALID_ARGUMENT', 'Request body must be a JSON object.', [
      {
        field: 'body',
        message: 'Expected a JSON object.',
      },
    ]);
  }

  return value as Record<string, unknown>;
};

const getCreateSource = (value: unknown): RuntimeTaskSource | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const source = getRequiredText(value, 'source');

  if (source !== 'api') {
    throw new AppError(400, 'INVALID_ARGUMENT', 'source must be api for POST /api/tasks.', [
      {
        field: 'source',
        message: 'Expected api.',
      },
    ]);
  }

  return source;
};

export const createTasksRouter = (
  dependencies: TaskRouteDependencies = {},
): Router => {
  const taskRepository = dependencies.taskRepository ?? defaultTaskRepository;
  const router = Router();

  router.get(
    '/tasks',
    (
      req: Request<unknown, unknown, unknown, TaskListQuery>,
      res: Response,
      next: NextFunction,
    ) => {
      try {
        const userId = getRequiredUserIdFromQuery(req.query.userId);
        const tasks = taskRepository.listTasksByOwner(userId);

        res.json({
          code: 'OK',
          message: 'ok',
          data: {
            tasks,
            recentExecutions: [],
          },
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/tasks',
    (
      req: Request<unknown, unknown, CreateTaskBody>,
      res: Response,
      next: NextFunction,
    ) => {
      try {
        const body = getObjectBody(req.body);

        assertAllowedKeys(body, ['alertScope', 'cron', 'enabled', 'source', 'userId']);

        const task = taskRepository.createTask({
          userId: getRequiredText(body.userId, 'userId'),
          alertScope: getRequiredText(body.alertScope, 'alertScope'),
          cron: getRequiredText(body.cron, 'cron'),
          enabled: getOptionalBoolean(body.enabled, 'enabled'),
          source: getCreateSource(body.source),
        });

        res.status(201).json({
          code: 'OK',
          message: 'ok',
          data: {
            task,
          },
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.patch(
    '/tasks/:taskId',
    (
      req: Request<TaskIdParams, unknown, UpdateTaskBody>,
      res: Response,
      next: NextFunction,
    ) => {
      try {
        const body = getObjectBody(req.body);

        assertAllowedKeys(body, ['alertScope', 'cron', 'enabled', 'userId']);

        const task = taskRepository.updateTask({
          taskId: getRequiredText(req.params.taskId, 'taskId'),
          userId: getRequiredText(body.userId, 'userId'),
          alertScope: getOptionalText(body.alertScope, 'alertScope'),
          cron: getOptionalText(body.cron, 'cron'),
          enabled: getOptionalBoolean(body.enabled, 'enabled'),
        });

        res.json({
          code: 'OK',
          message: 'ok',
          data: {
            task,
          },
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete(
    '/tasks/:taskId',
    (
      req: Request<TaskIdParams, unknown, unknown, DeleteTaskQuery>,
      res: Response,
      next: NextFunction,
    ) => {
      try {
        const result = taskRepository.deleteTask(
          getRequiredText(req.params.taskId, 'taskId'),
          getRequiredUserIdFromQuery(req.query.userId),
        );

        res.json({
          code: 'OK',
          message: 'ok',
          data: result,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
};

export default createTasksRouter();
