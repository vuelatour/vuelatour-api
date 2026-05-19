import { Module } from '@nestjs/common';
import { FundsController } from './funds.controller';
import { FundsService } from './funds.service';
import { FundMovementsController } from './fund-movements.controller';
import { FundMovementsService } from './fund-movements.service';

@Module({
  controllers: [FundsController, FundMovementsController],
  providers: [FundsService, FundMovementsService],
  exports: [FundsService, FundMovementsService],
})
export class CashFundsModule {}
