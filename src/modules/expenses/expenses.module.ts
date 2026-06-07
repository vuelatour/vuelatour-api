import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { PyservicesModule } from '../pyservices/pyservices.module';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';

@Module({
  imports: [RealtimeModule, PyservicesModule],
  controllers: [ExpensesController],
  providers: [ExpensesService],
  exports: [ExpensesService],
})
export class ExpensesModule {}
