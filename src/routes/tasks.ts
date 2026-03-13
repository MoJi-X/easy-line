import { Router, type Request, type Response, type NextFunction } from 'express';

import { schedulerService } from '../services/scheduler';
import { AppError } from '../errors/app-error';

const router = Router();

interface ExecuteTaskParams {
  taskId: string;
}

router.get('/tasks', (_req: Request, res: Response) => {
  res.json({
    code: 'OK',
    message: 'ok',
    data: {
      tasks: schedulerService.listTasks(),
      recentExecutions: schedulerService.listExecutionRecords(),
    },
  });
});

router.post(
  '/tasks/:taskId/execute',
  async (
    req: Request<ExecuteTaskParams>,
    res: Response,
    next: NextFunction,
  ) => {
    const { taskId } = req.params;

    if (!taskId) {
      next(new AppError(400, 'INVALID_ARGUMENT', 'taskId is required.'));
      return;
    }

    try {
      const result = await schedulerService.executeTask(taskId);
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

export default router;
